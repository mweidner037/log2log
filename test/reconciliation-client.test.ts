import { assert } from "chai";
import { describe, it } from "mocha";

import { BiMap } from "../src/data-structures/bi-map";
import { ChangeSet } from "../src/data-structures/change-set";
import { RenderedChangeSet } from "../src/data-structures/rendered-change-set";
import { Log2Log } from "../src/log2log";
import { ReconciliationReplica } from "../src/reconciliation-replica";
import { BaseValue } from "../src/types/model";
import { Mutation } from "../src/types/mutation";
import {
  Counter,
  Register,
  TTM,
  newInitialState,
  typeToModel,
} from "./test-models";

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function newClient(): ReconciliationReplica<TTM> {
  return new ReconciliationReplica(typeToModel, newInitialState());
}

/** A standalone server, used to produce realistic ChangeSets for the client. */
function newServer(): Log2Log<TTM> {
  return new Log2Log(typeToModel, newInitialState());
}

/** Applies a single mutation to a server and returns its resulting ChangeSet. */
function serverChanges(
  server: Log2Log<TTM>,
  mutation: Mutation<TTM>
): ChangeSet<TTM> {
  const {
    results: [result],
  } = server.applyMutations([mutation]);
  assert.isTrue(result.isSuccess);
  if (!result.isSuccess) throw new Error("unreachable");
  return result.changes;
}

function blindVal<V extends BaseValue>(
  changes: RenderedChangeSet<TTM>,
  type: keyof TTM,
  id: string
): V | undefined {
  return changes.sets.get(type, id) as V | undefined;
}

const addCounter =
  (id: string, delta: number): Mutation<TTM>["apply"] =>
  (tx) =>
    void tx
      .getMutable("counter", id, { type: "counter", id, count: 0 })
      .add(delta);

const setRegister =
  (id: string, value: string): Mutation<TTM>["apply"] =>
  (tx) =>
    tx.set<"register">({ type: "register", id, value });

let nextMutationId = 0;

/** Wraps a callback as a {@link Mutation}, assigning a unique id by default. */
function mut(
  callback: Mutation<TTM>["apply"],
  id = "auto-" + nextMutationId++
): Mutation<TTM> {
  return { id, apply: callback };
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("ReconciliationClient", () => {
  describe("reads", () => {
    it("get reflects the initial state, returning undefined for missing ids", () => {
      const client = newClient();
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 10,
      });
      assert.isUndefined(client.get("counter", "missing"));
    });

    it("getAll skips missing ids and preserves order", () => {
      const client = newClient();
      client.applyOptimisticMutation(
        // A new register, optimistically.
        mut(setRegister("r2", "second"), "m1")
      );
      assert.deepEqual(client.getAll("register", ["r2", "missing", "r"]), [
        { type: "register", id: "r2", value: "second" },
        { type: "register", id: "r", value: "initial" },
      ]);
    });
  });

  describe("applyOptimisticMutation", () => {
    it("updates the optimistic state and returns the changes as blind sets", () => {
      const client = newClient();
      const blindSets = client.applyOptimisticMutation(
        mut(addCounter("a", 5), "m1")
      );

      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });
      assert.deepEqual(blindVal<Counter>(blindSets, "counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });
    });

    it("reports a newly created value as a blind set", () => {
      const client = newClient();
      const blindSets = client.applyOptimisticMutation(
        mut(setRegister("r2", "hello"), "m1")
      );
      assert.deepEqual(blindVal<Register>(blindSets, "register", "r2"), {
        type: "register",
        id: "r2",
        value: "hello",
      });
      assert.deepEqual(client.get("register", "r2"), {
        type: "register",
        id: "r2",
        value: "hello",
      });
    });

    it("a throwing mutation propagates and changes nothing", () => {
      const client = newClient();
      const boom = new Error("boom");
      assert.throws(() => {
        client.applyOptimisticMutation(
          mut(() => {
            throw boom;
          }, "bad")
        );
      }, "boom");
      // The optimistic state is untouched.
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 10,
      });
      // The mutation was not stored: a later server change does not rerun it.
      const changes = client.applyServerChanges(
        emptyChangeSet(),

        []
      );
      assert.strictEqual(changes.sets.size, 0);
      assert.strictEqual(changes.deletes.size, 0);
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 10,
      });
    });

    it("stacks multiple optimistic mutations", () => {
      const client = newClient();
      client.applyOptimisticMutation(mut(addCounter("a", 5), "m1"));
      client.applyOptimisticMutation(mut(addCounter("a", 3), "m2"));
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 18,
      });
    });

    it("optimistically deletes a value, returning the deletion", () => {
      const client = newClient();
      const changes = client.applyOptimisticMutation(
        mut((tx) => tx.delete("counter", "a"), "m1")
      );

      assert.isUndefined(client.get("counter", "a"));
      assert.strictEqual(changes.sets.size, 0);
      assert.strictEqual(changes.deletes.size, 1);
      assert.isTrue(changes.deletes.has("counter", "a"));
    });
  });

  describe("applyServerChanges", () => {
    it("confirming a mutation incorporates it and stops rerunning it", () => {
      const client = newClient();
      client.applyOptimisticMutation(mut(addCounter("a", 5), "m1"));

      // The server applies the same mutation and reports the ChangeSet.
      const server = newServer();
      const changes = serverChanges(server, mut(addCounter("a", 5)));

      const blindSets = client.applyServerChanges(changes, ["m1"]);
      // The optimistic state matches the server state: count 15, applied once.
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });
      assert.deepEqual(blindVal<Counter>(blindSets, "counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });

      // A subsequent server change does not rerun the confirmed mutation.
      const server2 = newServer();
      server2.applyMutations([mut(addCounter("a", 5))]);
      const changes2 = serverChanges(server2, mut(addCounter("a", 1)));
      client.applyServerChanges(changes2, []);
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 16,
      });
    });

    it("reruns an unconfirmed mutation on top of a concurrent server change", () => {
      const client = newClient();
      client.applyOptimisticMutation(mut(addCounter("a", 5), "m1"));

      // A different client's mutation reaches the server first: a -> 110.
      const server = newServer();
      const changes = serverChanges(server, mut(addCounter("a", 100)));

      const blindSets = client.applyServerChanges(changes, []);
      // Server state is 110; m1 is rerun on top of it: 115.
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 115,
      });
      assert.deepEqual(blindVal<Counter>(blindSets, "counter", "a"), {
        type: "counter",
        id: "a",
        count: 115,
      });
    });

    it("reruns pending mutations in their original order", () => {
      const client = newClient();
      client.applyOptimisticMutation(mut(setRegister("r", "first"), "m1"));
      client.applyOptimisticMutation(mut(setRegister("r", "second"), "m2"));

      // A concurrent server change to an unrelated value.
      const server = newServer();
      const changes = serverChanges(server, mut(addCounter("a", 1)));

      client.applyServerChanges(changes, []);
      // Both reruns apply in order, so the last writer ("second") wins.
      assert.deepEqual(client.get("register", "r"), {
        type: "register",
        id: "r",
        value: "second",
      });
    });

    it("a rerun that throws becomes a no-op but stays pending", () => {
      const client = newClient();
      // A single authoritative server whose state the client mirrors, so its
      // update deltas compose against the client's server state.
      const server = newServer();
      // This mutation throws if the counter is already large.
      const cautiousAdd: Mutation<TTM>["apply"] = (tx) => {
        const current = tx.get("counter", "a")!;
        if (current.count >= 100) throw new Error("too big");
        tx.getMutable("counter", "a")!.add(5);
      };
      client.applyOptimisticMutation(mut(cautiousAdd, "m1"));
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });

      // Server jumps the counter to 200; the rerun throws and is skipped.
      const bigChanges = serverChanges(server, mut(addCounter("a", 190)));
      client.applyServerChanges(bigChanges, []);
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 200,
      });

      // Later the server brings it back down to 50; the still-pending mutation
      // now succeeds on rerun.
      const smallChanges = serverChanges(server, mut(addCounter("a", -150)));
      client.applyServerChanges(smallChanges, []);
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 55,
      });
    });

    it("applies a server change to a value with no pending mutations", () => {
      const client = newClient();
      const server = newServer();
      const changes = serverChanges(server, mut(setRegister("r", "remote")));

      const blindSets = client.applyServerChanges(changes, []);
      assert.deepEqual(client.get("register", "r"), {
        type: "register",
        id: "r",
        value: "remote",
      });
      assert.deepEqual(blindVal<Register>(blindSets, "register", "r"), {
        type: "register",
        id: "r",
        value: "remote",
      });
    });

    it("reports rolled-back optimistic changes in the returned blind sets", () => {
      const client = newClient();
      // This mutation only sets "r" while the counter is below a threshold.
      const conditionalSet: Mutation<TTM>["apply"] = (tx) => {
        if (tx.get("counter", "a")!.count < 100) {
          tx.set<"register">({ type: "register", id: "r", value: "low" });
        }
      };
      client.applyOptimisticMutation(mut(conditionalSet, "m1"));
      // Optimistically, "r" is "low".
      assert.deepEqual(client.get("register", "r"), {
        type: "register",
        id: "r",
        value: "low",
      });

      // The server bumps the counter past the threshold (not touching "r") and
      // does not confirm m1.
      const server = newServer();
      const changes = serverChanges(server, mut(addCounter("a", 200)));
      const blindSets = client.applyServerChanges(changes, []);

      // On rerun, m1 no longer sets "r", so the optimistic "r" rolls back to the
      // server value. That rollback must show up in the returned blind sets, so
      // a consumer that only applies blindSets stays in sync.
      assert.deepEqual(client.get("register", "r"), {
        type: "register",
        id: "r",
        value: "initial",
      });
      assert.deepEqual(blindVal<Register>(blindSets, "register", "r"), {
        type: "register",
        id: "r",
        value: "initial",
      });
    });

    it("deletes an optimistically-created value whose server mutation was a no-op", () => {
      const client = newClient();
      // Optimistically create a new counter "b".
      client.applyOptimisticMutation(
        mut(
          (tx) => tx.set<"counter">({ type: "counter", id: "b", count: 5 }),
          "m1"
        )
      );
      assert.deepEqual(client.get("counter", "b"), {
        type: "counter",
        id: "b",
        count: 5,
      });

      // The server processed m1 but its mutation failed there (a no-op), so m1
      // is confirmed without any server changes. "b" never existed on the
      // server, so it must be deleted from the optimistic state.
      const changes = client.applyServerChanges(emptyChangeSet(), ["m1"]);
      assert.isUndefined(client.get("counter", "b"));
      assert.strictEqual(changes.sets.size, 0);
      assert.strictEqual(changes.deletes.size, 1);
      assert.isTrue(changes.deletes.has("counter", "b"));
    });

    it("applies a server-side delete with no pending mutations", () => {
      const client = newClient();

      const server = newServer();
      const changes = serverChanges(
        server,
        mut((tx) => tx.delete("counter", "a"))
      );

      const rendered = client.applyServerChanges(changes, []);
      assert.isUndefined(client.get("counter", "a"));
      assert.strictEqual(rendered.sets.size, 0);
      assert.strictEqual(rendered.deletes.size, 1);
      assert.isTrue(rendered.deletes.has("counter", "a"));
    });

    it("keeps an optimistic value alive over a server delete of another key", () => {
      const client = newClient();
      // Optimistically bump counter "a".
      client.applyOptimisticMutation(mut(addCounter("a", 5), "m1"));

      // The server deletes the register "r" (an unrelated key).
      const server = newServer();
      const changes = serverChanges(
        server,
        mut((tx) => tx.delete("register", "r"))
      );

      const rendered = client.applyServerChanges(changes, []);
      // The unconfirmed optimistic mutation is reapplied on top of the new
      // server state, so "a" stays bumped while "r" is deleted.
      assert.deepEqual(client.get("counter", "a"), {
        type: "counter",
        id: "a",
        count: 15,
      });
      assert.isUndefined(client.get("register", "r"));
      assert.strictEqual(rendered.deletes.size, 1);
      assert.isTrue(rendered.deletes.has("register", "r"));
    });
  });
});

/** An empty ChangeSet, for server messages that confirm without state changes. */
function emptyChangeSet(): ChangeSet<TTM> {
  return new ChangeSet(
    typeToModel,
    new BiMap<TTM, BaseValue>(),
    new BiMap<TTM, object[]>()
  );
}
