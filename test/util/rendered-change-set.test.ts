import { assert } from "chai";
import { describe, it } from "mocha";

import { BiMap } from "../../src/data-structures/bi-map";
import { ChangeSet } from "../../src/data-structures/change-set";
import { RenderedChangeSet } from "../../src/data-structures/rendered-change-set";
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

/** Builds a ChangeSet from the given blind sets, updates, and deletes. */
function changeSet(
  blindSets: Array<Counter | Register> = [],
  updates: Array<{ value: Counter | Register; updates: object[] }> = [],
  deletes: Array<{ type: keyof TTM; id: string }> = []
): ChangeSet<TTM> {
  const result = new ChangeSet<TTM>(
    typeToModel,
    new BiMap<TTM, BaseValue>(),
    new BiMap<TTM, object[]>()
  );
  for (const value of blindSets) {
    result.blindSets.set(value.type, value.id, value);
  }
  for (const update of updates) {
    result.updates.set(update.value.type, update.value.id, update.updates);
  }
  for (const { type, id } of deletes) {
    result.deletes.add(type, id);
  }
  return result;
}

/** Returns the ids set for a type, for asserting on a sets BiMap. */
function setIds(rendered: RenderedChangeSet<TTM>, type: keyof TTM): string[] {
  return rendered.sets.getInner(type).map(([id]) => id);
}

/** Returns the deleted ids for a type, for asserting on a deletes BiMap. */
function deletedIds(
  rendered: RenderedChangeSet<TTM>,
  type: keyof TTM
): string[] {
  return rendered.deletes.getInner(type).map(([id]) => id);
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("RenderedChangeSet.apply", () => {
  it("records blind sets as sets", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.apply(changeSet([counter("a", 5), register("r", "x")]), state);

    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 5));
    assert.deepStrictEqual(
      rendered.sets.get("register", "r"),
      register("r", "x")
    );
    assert.strictEqual(rendered.deletes.size, 0);
  });

  it("records deletes as deletes", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.apply(changeSet([], [], [{ type: "counter", id: "a" }]), state);

    assert.deepStrictEqual(deletedIds(rendered, "counter"), ["a"]);
    assert.strictEqual(rendered.sets.size, 0);
  });

  it("renders updates against a previously set value", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "a", counter("a", 5));
    rendered.apply(
      changeSet([], [{ value: counter("a", 8), updates: [{ delta: 3 }] }]),
      state
    );

    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 8));
  });

  it("lets a blind set clear an earlier delete", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.delete("counter", "a");
    rendered.apply(changeSet([counter("a", 7)]), state);

    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 7));
    assert.strictEqual(rendered.deletes.size, 0);
  });

  it("lets a delete clear an earlier set", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "a", counter("a", 1));
    rendered.apply(changeSet([], [], [{ type: "counter", id: "a" }]), state);

    assert.deepStrictEqual(deletedIds(rendered, "counter"), ["a"]);
    assert.strictEqual(rendered.sets.size, 0);
  });

  it("lets a delete clear a value in the state", () => {
    const state = new BiMap<TTM, BaseValue>();
    state.set("counter", "a", counter("a", 1));
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.apply(changeSet([], [], [{ type: "counter", id: "a" }]), state);

    assert.deepStrictEqual(deletedIds(rendered, "counter"), ["a"]);
    assert.strictEqual(rendered.sets.size, 0);
  });

  it("throws on update to a value neither set nor in the state", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    assert.throws(
      () =>
        rendered.apply(
          changeSet([], [{ value: counter("a", 8), updates: [{ delta: 3 }] }]),
          state
        ),
      /does not exist/
    );
  });

  it("does not mutate the value previously set when rendering an update", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    const original = counter("a", 5);
    rendered.set("counter", "a", original);
    rendered.apply(
      changeSet([], [{ value: counter("a", 8), updates: [{ delta: 3 }] }]),
      state
    );

    assert.deepStrictEqual(original, counter("a", 5));
    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 8));
  });

  it("applies blind sets, updates, and deletes to disjoint keys together", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "b", counter("b", 1));
    rendered.apply(
      changeSet(
        [counter("a", 5)],
        [{ value: counter("b", 4), updates: [{ delta: 3 }] }],
        [{ type: "register", id: "r" }]
      ),
      state
    );

    assert.deepStrictEqual(setIds(rendered, "counter").sort(), ["a", "b"]);
    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 5));
    assert.deepStrictEqual(rendered.sets.get("counter", "b"), counter("b", 4));
    assert.deepStrictEqual(deletedIds(rendered, "register"), ["r"]);
  });
});

describe("RenderedChangeSet.invert", () => {
  it("inverts a set of a previously-existing value into a set of its old value", () => {
    const beforeState = new BiMap<TTM, BaseValue>();
    beforeState.set("counter", "a", counter("a", 1));
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "a", counter("a", 5));

    const inverse = rendered.invert(beforeState);

    assert.deepStrictEqual(inverse.sets.get("counter", "a"), counter("a", 1));
    assert.strictEqual(inverse.deletes.size, 0);
  });

  it("inverts a set of a new value into a delete", () => {
    const beforeState = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "a", counter("a", 5));

    const inverse = rendered.invert(beforeState);

    assert.deepStrictEqual(deletedIds(inverse, "counter"), ["a"]);
    assert.strictEqual(inverse.sets.size, 0);
  });

  it("inverts a delete of a previously-existing value into a set of its old value", () => {
    const beforeState = new BiMap<TTM, BaseValue>();
    beforeState.set("counter", "a", counter("a", 1));
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.delete("counter", "a");

    const inverse = rendered.invert(beforeState);

    assert.deepStrictEqual(inverse.sets.get("counter", "a"), counter("a", 1));
    assert.strictEqual(inverse.deletes.size, 0);
  });

  it("inverts a no-op delete of a nonexistent value into nothing", () => {
    const beforeState = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.delete("counter", "a");

    const inverse = rendered.invert(beforeState);

    assert.strictEqual(inverse.sets.size, 0);
    assert.strictEqual(inverse.deletes.size, 0);
  });

  it("applying the inverse after the original restores the before state", () => {
    const beforeState = new BiMap<TTM, BaseValue>();
    beforeState.set("counter", "a", counter("a", 1));
    beforeState.set("counter", "b", counter("b", 2));
    beforeState.set("register", "r", register("r", "x"));

    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.set("counter", "a", counter("a", 9));
    rendered.set("counter", "c", counter("c", 3));
    rendered.delete("counter", "b");
    rendered.delete("register", "r");

    const inverse = rendered.invert(beforeState);

    // Simulate applying `rendered` then `inverse` to a copy of beforeState.
    const state = new RenderedChangeSet<TTM>(typeToModel);
    state.applyRendered(rendered);
    state.applyRendered(inverse);

    assert.deepStrictEqual(state.sets.get("counter", "a"), counter("a", 1));
    assert.deepStrictEqual(state.sets.get("counter", "b"), counter("b", 2));
    assert.deepStrictEqual(state.sets.get("register", "r"), register("r", "x"));
    assert.isUndefined(state.sets.get("counter", "c"));
    assert.isTrue(state.deletes.has("counter", "c"));
  });
});
