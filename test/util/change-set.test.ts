import { assert } from "chai";
import { describe, it } from "mocha";

import { BaseValue } from "../../src/model";
import { BiMap } from "../../src/util/bi-map";
import { ChangeSet, mergeChangeSets } from "../../src/util/change-set";
import { Counter, Register, TTM } from "../test-models";

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function counter(id: string, count: number): Counter {
  return { type: "counter", id, count };
}

function register(id: string, value: string): Register {
  return { type: "register", id, value };
}

function emptyChangeSet(): ChangeSet<TTM> {
  return {
    blindSets: new BiMap<TTM, BaseValue>(),
    updates: new BiMap<TTM, { value: BaseValue; updates: object[] }>(),
  };
}

/** Builds a ChangeSet from the given blind sets and updates. */
function changeSet(
  blindSets: Array<Counter | Register> = [],
  updates: Array<{ value: Counter | Register; updates: object[] }> = []
): ChangeSet<TTM> {
  const result = emptyChangeSet();
  for (const value of blindSets) {
    result.blindSets.set(value.type, value.id, value);
  }
  for (const update of updates) {
    result.updates.set(update.value.type, update.value.id, update);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("mergeChangeSets", () => {
  it("returns an empty ChangeSet for no inputs", () => {
    const merged = mergeChangeSets<TTM>([]);
    assert.strictEqual(merged.blindSets.size, 0);
    assert.strictEqual(merged.updates.size, 0);
  });

  it("returns a single ChangeSet's contents unchanged", () => {
    const cs = changeSet(
      [counter("a", 5)],
      [{ value: register("r", "hi"), updates: [{ value: "hi" }] }]
    );
    const merged = mergeChangeSets([cs]);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 5)
    );
    assert.deepStrictEqual(merged.updates.get("register", "r"), {
      value: register("r", "hi"),
      updates: [{ value: "hi" }],
    });
  });

  it("combines changes to disjoint keys", () => {
    const merged = mergeChangeSets([
      changeSet([counter("a", 1)]),
      changeSet([register("r", "x")]),
    ]);
    assert.strictEqual(merged.blindSets.size, 2);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 1)
    );
    assert.deepStrictEqual(
      merged.blindSets.get("register", "r"),
      register("r", "x")
    );
  });

  it("lets a later blind set override an earlier one", () => {
    const merged = mergeChangeSets([
      changeSet([counter("a", 1)]),
      changeSet([counter("a", 2)]),
    ]);
    assert.strictEqual(merged.blindSets.size, 1);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 2)
    );
  });

  it("lets a later blind set override an earlier update", () => {
    const merged = mergeChangeSets([
      changeSet([], [{ value: counter("a", 3), updates: [{ delta: 1 }] }]),
      changeSet([counter("a", 7)]),
    ]);
    assert.strictEqual(merged.updates.size, 0);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 7)
    );
  });

  it("concatenates updates to the same key, keeping the later value", () => {
    const merged = mergeChangeSets([
      changeSet([], [{ value: counter("a", 11), updates: [{ delta: 1 }] }]),
      changeSet([], [{ value: counter("a", 13), updates: [{ delta: 2 }] }]),
    ]);
    assert.strictEqual(merged.blindSets.size, 0);
    assert.deepStrictEqual(merged.updates.get("counter", "a"), {
      value: counter("a", 13),
      updates: [{ delta: 1 }, { delta: 2 }],
    });
  });

  it("keeps a key a blind set when followed by an update", () => {
    const merged = mergeChangeSets([
      changeSet([counter("a", 10)]),
      changeSet([], [{ value: counter("a", 12), updates: [{ delta: 2 }] }]),
    ]);
    assert.strictEqual(merged.updates.size, 0);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 12)
    );
  });

  it("does not mutate the input update arrays", () => {
    const first = { value: counter("a", 11), updates: [{ delta: 1 }] };
    const second = { value: counter("a", 13), updates: [{ delta: 2 }] };
    mergeChangeSets([changeSet([], [first]), changeSet([], [second])]);
    assert.deepStrictEqual(first.updates, [{ delta: 1 }]);
    assert.deepStrictEqual(second.updates, [{ delta: 2 }]);
  });
});
