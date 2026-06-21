import { assert } from "chai";
import { describe, it } from "mocha";

import { ApplyMutationResult, ChangeSet, Log2Log } from "../src/log2log";
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

function findUpdate<V extends BaseValue>(
  changes: ChangeSet<TTM>,
  type: keyof TTM,
  id: string
): { value: V; updates: object[] } | undefined {
  return changes.updates.get(type, id) as
    | { value: V; updates: object[] }
    | undefined;
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
    const [result] = newLog2Log().applyMutations([
      mut((tx) => {
        tx.getMutable("counter", "a")!.add(7);
        tx.getMutable("register", "r")!.setValue("hello");
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);

    const counterUpdate = findUpdate<Counter>(changes, "counter", "a")!;
    assert.deepEqual(counterUpdate.value, {
      type: "counter",
      id: "a",
      count: 17,
    });
    assert.deepEqual(counterUpdate.updates, [{ delta: 7 }]);

    const registerUpdate = findUpdate<Register>(changes, "register", "r")!;
    assert.deepEqual(registerUpdate.value, {
      type: "register",
      id: "r",
      value: "hello",
    });
    assert.deepEqual(registerUpdate.updates, [{ value: "hello" }]);
  });

  it("omits mutables that were touched but not changed", () => {
    const [result] = newLog2Log().applyMutations([
      mut((tx) => {
        tx.getMutable("counter", "a");
      }),
    ]);
    const changes = expectSuccess(result);
    assert.strictEqual(changes.blindSets.size, 0);
    assert.strictEqual(changes.updates.size, 0);
  });

  it("reports set values as blind sets", () => {
    const [result] = newLog2Log().applyMutations([
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
    const [result] = newLog2Log().applyMutations([
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
    const [first, second] = newLog2Log().applyMutations([
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
    const update = findUpdate<Counter>(secondChanges, "counter", "b")!;
    assert.deepEqual(update.value, { type: "counter", id: "b", count: 5 });
    assert.deepEqual(update.updates, [{ delta: 2 }]);
  });

  it("a failed mutation is reported as a failure and does not affect state", () => {
    const boom = new Error("boom");
    const [first, second, third] = newLog2Log().applyMutations([
      mut((tx) => tx.getMutable("counter", "a")!.add(5)),
      mut(() => {
        throw boom;
      }, "boom"),
      mut((tx) => tx.getMutable("counter", "a")!.add(3)),
    ]);
    // The failed mutation is reported as a failure carrying its error.
    assert.strictEqual(expectError(second), boom);
    // The surrounding mutations succeed, and the failed one did not disturb the
    // state seen by the later mutation: 'a' goes 10 -> 15 -> 18.
    const firstUpdate = findUpdate<Counter>(
      expectSuccess(first),
      "counter",
      "a"
    )!;
    assert.deepEqual(firstUpdate.value, {
      type: "counter",
      id: "a",
      count: 15,
    });
    const thirdUpdate = findUpdate<Counter>(
      expectSuccess(third),
      "counter",
      "a"
    )!;
    assert.deepEqual(thirdUpdate.value, {
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
});
