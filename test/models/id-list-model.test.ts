import { assert } from "chai";
import { describe, it } from "mocha";

import { ElementId, IdList } from "articulated";
import {
  IdListUpdate,
  IdListValue,
  MutableIdListValue,
  defineIdListModel,
} from "../../src/models/id-list-model";

/* -------------------------------------------------------------------------- */
/* Sample model and helpers.                                                  */
/* -------------------------------------------------------------------------- */

const listModel = defineIdListModel("list");

/** An ElementId in bunch "b" with the given counter. */
function id(counter: number): ElementId {
  return { bunchId: "b", counter };
}

function newValue(): IdListValue<"list"> {
  return { type: "list", id: "l1", list: IdList.new() };
}

/** Observable state of a list: its known ids with deleted status, in order. */
function snapshot(list: IdList): { id: ElementId; isDeleted: boolean }[] {
  return [...list.valuesWithIsDeleted()];
}

/**
 * Runs `mutate` against a fresh mutable, then checks that replaying the
 * recorded updates onto the original value reproduces the mutable's final
 * list. Returns the final value and updates.
 */
function roundtrip(mutate: (m: MutableIdListValue<"list">) => void): {
  value: IdListValue<"list">;
  updates: IdListUpdate[];
} {
  const original = newValue();
  const m = listModel.toMutable(original);
  mutate(m);
  const { value, updates } = m.__finish();

  // Replaying the updates onto a fresh value reproduces the final list.
  const replayed = listModel.applyUpdates(newValue(), updates);
  assert.deepEqual(
    snapshot(replayed.list),
    snapshot(value.list),
    "applyUpdates did not reproduce __finish().value"
  );

  // The original value's list is untouched (IdList is persistent).
  assert.deepEqual(
    snapshot(original.list),
    snapshot(IdList.new()),
    "the input value was mutated"
  );
  return { value, updates };
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("id-list-model roundtrip", () => {
  it("no-op mutation", () => {
    const { value, updates } = roundtrip(() => {});
    assert.deepEqual(snapshot(value.list), []);
    assert.deepEqual(updates, []);
  });

  it("insertAfter / insertBefore", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0));
      m.insertAfter(id(0), id(1));
      m.insertBefore(id(0), id(2));
      m.insertBefore(null, id(3));
    });
    assert.deepEqual(
      snapshot(value.list).map((e) => e.id.counter),
      [2, 0, 1, 3]
    );
    assert.deepEqual(updates, [
      { op: "insertAfter", before: null, newId: id(0) },
      { op: "insertAfter", before: id(0), newId: id(1) },
      { op: "insertBefore", after: id(0), newId: id(2) },
      { op: "insertBefore", after: null, newId: id(3) },
    ]);
  });

  it("bulk insert with count", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0), 3);
    });
    assert.deepEqual(
      snapshot(value.list).map((e) => e.id.counter),
      [0, 1, 2]
    );
    assert.deepEqual(updates, [
      { op: "insertAfter", before: null, newId: id(0), count: 3 },
    ]);
  });

  it("delete and undelete", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0), 3);
      m.delete(id(1));
      m.undelete(id(1));
      m.delete(id(2));
    });
    assert.deepEqual(snapshot(value.list), [
      { id: id(0), isDeleted: false },
      { id: id(1), isDeleted: false },
      { id: id(2), isDeleted: true },
    ]);
    assert.deepEqual(updates, [
      { op: "insertAfter", before: null, newId: id(0), count: 3 },
      { op: "delete", id: id(1) },
      { op: "undelete", id: id(1) },
      { op: "delete", id: id(2) },
    ]);
  });

  it("deleteRange", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0), 4);
      m.deleteRange(1, 3);
    });
    assert.deepEqual(snapshot(value.list), [
      { id: id(0), isDeleted: false },
      { id: id(1), isDeleted: true },
      { id: id(2), isDeleted: true },
      { id: id(3), isDeleted: false },
    ]);
    assert.deepEqual(updates, [
      { op: "insertAfter", before: null, newId: id(0), count: 4 },
      { op: "deleteRange", from: 1, to: 3 },
    ]);
  });

  it("uninsert", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0), 2);
      m.uninsert(id(1));
    });
    assert.deepEqual(snapshot(value.list), [{ id: id(0), isDeleted: false }]);
    assert.deepEqual(updates, [
      { op: "insertAfter", before: null, newId: id(0), count: 2 },
      { op: "uninsert", id: id(1) },
    ]);
  });

  it("survives JSON serialization of updates", () => {
    const { value, updates } = roundtrip((m) => {
      m.insertAfter(null, id(0), 3);
      m.delete(id(1));
      m.insertBefore(id(0), id(5));
    });
    const serialized = JSON.parse(JSON.stringify(updates)) as IdListUpdate[];
    const replayed = listModel.applyUpdates(newValue(), serialized);
    assert.deepEqual(snapshot(replayed.list), snapshot(value.list));
  });

  it("save / load round-trips the value", () => {
    const { value } = roundtrip((m) => {
      m.insertAfter(null, id(0), 3);
      m.delete(id(1));
    });
    const loaded = listModel.load(listModel.save(value));
    assert.strictEqual(loaded.type, "list");
    assert.strictEqual(loaded.id, "l1");
    assert.deepEqual(snapshot(loaded.list), snapshot(value.list));
  });
});
