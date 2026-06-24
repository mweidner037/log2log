import { assert } from "chai";
import { describe, it } from "mocha";

import { BiMap } from "../../src/data-structures/bi-map";
import {
  ChangeSet,
  mergeChangeSets,
} from "../../src/data-structures/change-set";
import { BaseValue } from "../../src/types/model";
import { Counter, Register, TTM, typeToModel } from "../test-models";

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
  return new ChangeSet(
    typeToModel,
    new BiMap<TTM, BaseValue>(),
    new BiMap<TTM, object[]>()
  );
}

/** Builds a ChangeSet from the given blind sets, updates, and deletes. */
function changeSet(
  blindSets: Array<Counter | Register> = [],
  updates: Array<{ value: Counter | Register; updates: object[] }> = [],
  deletes: Array<{ type: keyof TTM; id: string }> = []
): ChangeSet<TTM> {
  const result = emptyChangeSet();
  for (const value of blindSets) {
    result.blindSets.set(value.type, value.id, value);
  }
  for (const update of updates) {
    result.updates.set(update.value.type, update.value.id, update.updates);
  }
  for (const { type, id } of deletes) {
    result.deletes.set(type, id, true);
  }
  return result;
}

/** Returns the deleted ids for a type, for asserting on a deletes BiMap. */
function deletedIds(changes: ChangeSet<TTM>, type: keyof TTM): string[] {
  return changes.deletes.getInner(type).map(([id]) => id);
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("mergeChangeSets", () => {
  it("returns an empty ChangeSet for no inputs", () => {
    const merged = mergeChangeSets(typeToModel, []);
    assert.strictEqual(merged.blindSets.size, 0);
    assert.strictEqual(merged.updates.size, 0);
  });

  it("returns a single ChangeSet's contents unchanged", () => {
    const cs = changeSet(
      [counter("a", 5)],
      [{ value: register("r", "hi"), updates: [{ value: "hi" }] }]
    );
    const merged = mergeChangeSets(typeToModel, [cs]);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 5)
    );
    assert.deepStrictEqual(merged.updates.get("register", "r"), [
      { value: "hi" },
    ]);
  });

  it("combines changes to disjoint keys", () => {
    const merged = mergeChangeSets(typeToModel, [
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
    const merged = mergeChangeSets(typeToModel, [
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
    const merged = mergeChangeSets(typeToModel, [
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
    const merged = mergeChangeSets(typeToModel, [
      changeSet([], [{ value: counter("a", 11), updates: [{ delta: 1 }] }]),
      changeSet([], [{ value: counter("a", 13), updates: [{ delta: 2 }] }]),
    ]);
    assert.strictEqual(merged.blindSets.size, 0);
    assert.deepStrictEqual(merged.updates.get("counter", "a"), [
      { delta: 1 },
      { delta: 2 },
    ]);
  });

  it("keeps a key a blind set when followed by an update", () => {
    const merged = mergeChangeSets(typeToModel, [
      changeSet([counter("a", 10)]),
      changeSet([], [{ value: counter("a", 12), updates: [{ delta: 2 }] }]),
    ]);
    assert.strictEqual(merged.updates.size, 0);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 12)
    );
  });

  it("lets a later delete override an earlier blind set and update", () => {
    const merged = mergeChangeSets(typeToModel, [
      changeSet([counter("a", 1)]),
      changeSet([], [{ value: counter("b", 5), updates: [{ delta: 1 }] }]),
      changeSet(
        [],
        [],
        [
          { type: "counter", id: "a" },
          { type: "counter", id: "b" },
        ]
      ),
    ]);
    assert.strictEqual(merged.blindSets.size, 0);
    assert.strictEqual(merged.updates.size, 0);
    assert.deepStrictEqual(deletedIds(merged, "counter").sort(), ["a", "b"]);
  });

  it("lets a later blind set override an earlier delete", () => {
    const merged = mergeChangeSets(typeToModel, [
      changeSet([], [], [{ type: "counter", id: "a" }]),
      changeSet([counter("a", 7)]),
    ]);
    assert.strictEqual(merged.deletes.size, 0);
    assert.deepStrictEqual(
      merged.blindSets.get("counter", "a"),
      counter("a", 7)
    );
  });

  it("deduplicates repeated deletes of the same key", () => {
    const merged = mergeChangeSets(typeToModel, [
      changeSet([], [], [{ type: "counter", id: "a" }]),
      changeSet([], [], [{ type: "counter", id: "a" }]),
    ]);
    assert.strictEqual(merged.deletes.size, 1);
    assert.deepStrictEqual(deletedIds(merged, "counter"), ["a"]);
  });

  it("does not mutate the input update arrays", () => {
    const first = { value: counter("a", 11), updates: [{ delta: 1 }] };
    const second = { value: counter("a", 13), updates: [{ delta: 2 }] };
    mergeChangeSets(typeToModel, [
      changeSet([], [first]),
      changeSet([], [second]),
    ]);
    assert.deepStrictEqual(first.updates, [{ delta: 1 }]);
    assert.deepStrictEqual(second.updates, [{ delta: 2 }]);
  });
});

describe("ChangeSet save/load", () => {
  it("round-trips blind sets and updates", () => {
    const original = changeSet(
      [counter("a", 5), register("r", "hello")],
      [{ value: counter("b", 8), updates: [{ delta: 3 }] }]
    );

    const restored = ChangeSet.load<TTM>(typeToModel, original.save());

    assert.deepStrictEqual(
      restored.blindSets.get("counter", "a"),
      counter("a", 5)
    );
    assert.deepStrictEqual(
      restored.blindSets.get("register", "r"),
      register("r", "hello")
    );
    assert.deepStrictEqual(restored.updates.get("counter", "b"), [
      { delta: 3 },
    ]);
  });

  it("round-trips deletes", () => {
    const original = changeSet(
      [counter("a", 5)],
      [],
      [
        { type: "counter", id: "gone" },
        { type: "register", id: "old" },
      ]
    );

    const restored = ChangeSet.load<TTM>(typeToModel, original.save());

    assert.deepStrictEqual(
      restored.blindSets.get("counter", "a"),
      counter("a", 5)
    );
    assert.deepStrictEqual(deletedIds(restored, "counter"), ["gone"]);
    assert.deepStrictEqual(deletedIds(restored, "register"), ["old"]);
  });
});
