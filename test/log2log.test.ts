import { assert } from "chai";
import { describe, it } from "mocha";

import { ApplyMutationResult, Log2Log } from "../src/log2log";
import { ChangeSet } from "../src/util/change-set";
import { BaseValue } from "../src/model";
import { Mutation } from "../src/mutation";
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

function newLog2Log(): Log2Log<TTM> {
  return new Log2Log(typeToModel, newInitialState());
}

let nextMutationId = 0;

/** Wraps a callback as a {@link Mutation}, assigning a unique id by default. */
function mut(
  callback: Mutation<TTM>["apply"],
  id = "auto-" + nextMutationId++
): Mutation<TTM> {
  return { id, apply: callback };
}

/** Asserts that a result succeeded and returns its changes. */
function expectSuccess(result: ApplyMutationResult<TTM>): ChangeSet<TTM> {
  assert.isTrue(result.isSuccess);
  if (!result.isSuccess) throw new Error("unreachable");
  return result.changes;
}

/** Asserts that a result failed and returns its error. */
function expectError(result: ApplyMutationResult<TTM>): unknown {
  assert.isFalse(result.isSuccess);
  if (result.isSuccess) throw new Error("unreachable");
  return result.error;
}

function findSet<V extends BaseValue>(
  changes: ChangeSet<TTM>,
  type: keyof TTM,
  id: string
): V | undefined {
  return changes.blindSets.get(type, id) as V | undefined;
}

function findUpdate(
  changes: ChangeSet<TTM>,
  type: keyof TTM,
  id: string
): object[] | undefined {
  return changes.updates.get(type, id);
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("applyMutations", () => {
  it("reads fall through to the initial state", () => {
    let read: Counter | undefined;
    let missing: Counter | undefined;
    newLog2Log().applyMutations([
      mut((tx) => {
        read = tx.get("counter", "a");
        missing = tx.get("counter", "missing");
      }),
    ]);
    assert.deepEqual(read, { type: "counter", id: "a", count: 10 });
    assert.isUndefined(missing);
  });

  it("reports updates for mutated existing values", () => {
    const {
      results: [result],
      rendered: { sets: allSets },
    } = newLog2Log().applyMutations([
      mut((tx) => {
        tx.getMutable("counter", "a")!.add(7);
        tx.getMutable("register", "r")!.setValue("hello");
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);

    // The ChangeSet records the updates; the final values come from allSets.
    assert.deepEqual(findUpdate(changes, "counter", "a"), [{ delta: 7 }]);
    assert.deepEqual(allSets.get("counter", "a") as Counter, {
      type: "counter",
      id: "a",
      count: 17,
    });

    assert.deepEqual(findUpdate(changes, "register", "r"), [
      { value: "hello" },
    ]);
    assert.deepEqual(allSets.get("register", "r") as Register, {
      type: "register",
      id: "r",
      value: "hello",
    });
  });

  it("omits mutables that were touched but not changed", () => {
    const {
      results: [result],
    } = newLog2Log().applyMutations([
      mut((tx) => {
        tx.getMutable("counter", "a");
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);
    assert.strictEqual(changes.updates.size, 0);
  });

  it("reports set values as blind sets", () => {
    const {
      results: [result],
    } = newLog2Log().applyMutations([
      mut((tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 })),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "b"), {
      type: "counter",
      id: "b",
      count: 3,
    });
  });

  it("getMutable with initialValue creates a new value, committed as a set", () => {
    const {
      results: [result],
    } = newLog2Log().applyMutations([
      mut(
        (tx) =>
          void tx.getMutable("counter", "new", {
            type: "counter",
            id: "new",
            count: 1,
          })
      ),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "new"), {
      type: "counter",
      id: "new",
      count: 1,
    });
  });

  it("a value created in one mutation is visible to later mutations", () => {
    const {
      results: [first, second],
      rendered: { sets: allSets },
    } = newLog2Log().applyMutations([
      mut((tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 })),
      mut((tx) => {
        // 'b' is now in the state, so it reads as an existing value.
        assert.deepEqual(tx.get("counter", "b"), {
          type: "counter",
          id: "b",
          count: 3,
        });
        tx.getMutable("counter", "b")!.add(2);
      }),
    ]);
    // The first mutation creates 'b' as a blind set.
    const firstChanges = expectSuccess(first);
    assert.deepEqual(findSet<Counter>(firstChanges, "counter", "b"), {
      type: "counter",
      id: "b",
      count: 3,
    });
    // The second mutation sees 'b' as existing and reports its own update.
    const secondChanges = expectSuccess(second);
    assert.deepEqual(findUpdate(secondChanges, "counter", "b"), [{ delta: 2 }]);
    // The accumulated final value reflects both mutations: 3 + 2 = 5.
    assert.deepEqual(allSets.get("counter", "b") as Counter, {
      type: "counter",
      id: "b",
      count: 5,
    });
  });

  it("a failed mutation is reported as a failure and does not affect state", () => {
    const boom = new Error("boom");
    const {
      results: [first, second, third],
      rendered: { sets: allSets },
    } = newLog2Log().applyMutations([
      mut((tx) => tx.getMutable("counter", "a")!.add(5)),
      mut(() => {
        throw boom;
      }, "boom"),
      mut((tx) => tx.getMutable("counter", "a")!.add(3)),
    ]);
    // The failed mutation is reported as a failure carrying its error.
    assert.strictEqual(expectError(second), boom);
    // The surrounding mutations succeed, and the failed one did not disturb the
    // state seen by the later mutation: 'a' goes 10 -> 15 -> 18. Each mutation
    // records its own delta, and allSets holds the final accumulated value.
    assert.deepEqual(findUpdate(expectSuccess(first), "counter", "a"), [
      { delta: 5 },
    ]);
    assert.deepEqual(findUpdate(expectSuccess(third), "counter", "a"), [
      { delta: 3 },
    ]);
    assert.deepEqual(allSets.get("counter", "a") as Counter, {
      type: "counter",
      id: "a",
      count: 18,
    });
  });

  it("getAll and getAllMutable skip missing ids and reflect local state", () => {
    let all: Counter[] = [];
    let mutableCount = 0;
    newLog2Log().applyMutations([
      mut((tx) => {
        tx.set<"counter">({ type: "counter", id: "b", count: 3 });
        all = tx.getAll("counter", ["a", "missing", "b"]);
        mutableCount = tx.getAllMutable("counter", [
          "a",
          "missing",
          "b",
        ]).length;
      }),
    ]);
    assert.deepEqual(all, [
      { type: "counter", id: "a", count: 10 },
      { type: "counter", id: "b", count: 3 },
    ]);
    assert.strictEqual(mutableCount, 2);
  });

  it("save returns the state after applying mutations", () => {
    const l2l = newLog2Log();
    l2l.applyMutations([
      mut((tx) => tx.getMutable("counter", "a")!.add(5)),
      mut((tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 })),
      mut((tx) => tx.getMutable("register", "r")!.setValue("hello")),
    ]);
    const saved = l2l.save();

    const counters = [...(saved.counter as Counter[])].sort((x, y) =>
      x.id.localeCompare(y.id)
    );
    assert.deepEqual(counters, [
      { type: "counter", id: "a", count: 15 },
      { type: "counter", id: "b", count: 3 },
    ]);
    assert.deepEqual(saved.register, [
      { type: "register", id: "r", value: "hello" },
    ]);
  });

  it("reports a delete and removes the value from the state", () => {
    const l2l = newLog2Log();
    const {
      results: [result],
      rendered: { sets: allSets, deletes },
    } = l2l.applyMutations([mut((tx) => tx.delete("counter", "a"))]);

    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);
    assert.strictEqual(changes.updates.size, 0);
    assert.strictEqual(changes.deletes.size, 1);
    assert.isTrue(changes.deletes.has("counter", "a"));

    // The rendered result reports the delete and no longer the value.
    assert.strictEqual(allSets.size, 0);
    assert.strictEqual(deletes.size, 1);
    assert.isTrue(deletes.has("counter", "a"));

    // The value is gone from the state.
    assert.deepEqual(l2l.save().counter, []);
  });

  it("a deleted value reads as absent within the same mutation", () => {
    let read: Counter | undefined = { type: "counter", id: "a", count: -1 };
    newLog2Log().applyMutations([
      mut((tx) => {
        tx.delete("counter", "a");
        read = tx.get("counter", "a");
      }),
    ]);
    assert.isUndefined(read);
  });

  it("deleting a nonexistent value still records the delete", () => {
    const {
      results: [result],
    } = newLog2Log().applyMutations([
      mut((tx) => tx.delete("counter", "missing")),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.deletes.size, 1);
    assert.isTrue(changes.deletes.has("counter", "missing"));
  });

  it("a set after a delete overrides it, reported as a blind set", () => {
    const {
      results: [result],
      rendered: { deletes },
    } = newLog2Log().applyMutations([
      mut((tx) => {
        tx.delete("counter", "a");
        tx.set<"counter">({ type: "counter", id: "a", count: 99 });
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.deletes.size, 0);
    assert.strictEqual(deletes.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "a"), {
      type: "counter",
      id: "a",
      count: 99,
    });
  });

  it("a delete after a set overrides it, reported as a delete", () => {
    const {
      results: [result],
      rendered: { sets: allSets, deletes },
    } = newLog2Log().applyMutations([
      mut((tx) => {
        tx.set<"counter">({ type: "counter", id: "b", count: 3 });
        tx.delete("counter", "b");
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);
    assert.strictEqual(changes.deletes.size, 1);
    assert.isTrue(changes.deletes.has("counter", "b"));
    assert.strictEqual(allSets.size, 0);
    assert.strictEqual(deletes.size, 1);
    assert.isTrue(deletes.has("counter", "b"));
  });

  it("getMutable resurrects a deleted value from initialValue", () => {
    const {
      results: [result],
      rendered: { deletes },
    } = newLog2Log().applyMutations([
      mut((tx) => {
        tx.delete("counter", "a");
        assert.isUndefined(tx.getMutable("counter", "a"));
        tx.getMutable("counter", "a", {
          type: "counter",
          id: "a",
          count: 1,
        }).add(4);
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.deletes.size, 0);
    assert.strictEqual(deletes.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "a"), {
      type: "counter",
      id: "a",
      count: 5,
    });
  });
});
