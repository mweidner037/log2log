import { assert } from "chai";
import { describe, it } from "mocha";

import { BaseValue } from "../../src/model";
import { BiMap } from "../../src/util/bi-map";
import { ChangeSet } from "../../src/util/change-set";
import { RenderedChangeSet } from "../../src/util/rendered-change-set";
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
    result.deletes.set(type, id, true);
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
    rendered.recordSet("counter", "a", counter("a", 5));
    rendered.apply(
      changeSet([], [{ value: counter("a", 8), updates: [{ delta: 3 }] }]),
      state
    );

    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 8));
  });

  it("renders updates against a value set in the same apply", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.apply(
      changeSet(
        [counter("a", 5)],
        [{ value: counter("a", 8), updates: [{ delta: 3 }] }]
      ),
      state
    );

    // The blind set is applied first, then the update on top of it.
    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 8));
  });

  it("lets a blind set clear an earlier delete", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.recordDelete("counter", "a");
    rendered.apply(changeSet([counter("a", 7)]), state);

    assert.deepStrictEqual(rendered.sets.get("counter", "a"), counter("a", 7));
    assert.strictEqual(rendered.deletes.size, 0);
  });

  it("lets a delete clear an earlier set", () => {
    const state = new BiMap<TTM, BaseValue>();
    const rendered = new RenderedChangeSet<TTM>(typeToModel);
    rendered.recordSet("counter", "a", counter("a", 1));
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
    rendered.recordSet("counter", "a", original);
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
    rendered.recordSet("counter", "b", counter("b", 1));
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
