import { assert } from "chai";
import { describe, it } from "mocha";

import { Log2Log } from "../../src/log2log";
import { BaseValue } from "../../src/model";
import { JsonPatch, defineJsonModel } from "../../src/models/json-model";
import { SavedState } from "../../src/saved-state";

/* -------------------------------------------------------------------------- */
/* Sample type and model.                                                     */
/* -------------------------------------------------------------------------- */

// Note: the mutable type is `Doc & MutableValue<...>`, so `Doc` uses writable
// properties; `Readonly<Doc>` is the immutable value type.
interface Doc extends BaseValue<"doc"> {
  title: string;
  tags: string[];
  meta: {
    author: string;
    views: number;
    nested?: { deep: number };
  };
  items: { id: number; name: string }[];
}

const docModel = defineJsonModel<Doc>();

function newDoc(): Doc {
  return {
    type: "doc",
    id: "d1",
    title: "Hello",
    tags: ["a", "b"],
    meta: { author: "alice", views: 0 },
    items: [
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ],
  };
}

/**
 * Runs `mutate` against a fresh mutable, then checks that replaying the
 * recorded updates onto the original value reproduces the mutable's final
 * value. Returns that final value.
 */
function roundtrip(
  mutate: (m: ReturnType<typeof docModel.toMutable>) => void
): {
  value: Readonly<Doc>;
  updates: JsonPatch[];
} {
  const original = newDoc();
  const m = docModel.toMutable(original);
  mutate(m);
  const { value, updates } = m._finish();

  // Replaying the updates reproduces the final value.
  const replayed = docModel.applyUpdates(newDoc(), updates);
  assert.deepEqual(
    replayed,
    value,
    "applyUpdates did not reproduce _finish().value"
  );
  // The original value is never mutated.
  assert.deepEqual(original, newDoc(), "the input value was mutated");
  return { value, updates };
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("json-model roundtrip", () => {
  it("no-op mutation", () => {
    const { value, updates } = roundtrip(() => {});
    assert.deepEqual(value, newDoc());
    assert.deepEqual(updates, []);
  });

  it("scalar and nested replacements", () => {
    const { value } = roundtrip((m) => {
      m.title = "Changed";
      m.meta.views = 99;
      m.items[0].name = "ONE";
    });
    assert.strictEqual(value.title, "Changed");
    assert.strictEqual(value.meta.views, 99);
    assert.strictEqual(value.items[0].name, "ONE");
  });

  it("adding and removing object properties", () => {
    const { value } = roundtrip((m) => {
      m.meta.nested = { deep: 7 };
      m.meta.nested = { deep: 8 };
      delete m.meta.nested;
    });
    assert.notProperty(value.meta, "nested");
  });

  it("array push/pop/shift/unshift", () => {
    const { value } = roundtrip((m) => {
      m.tags.push("c", "d");
      m.tags.shift();
      m.tags.unshift("z");
      m.tags.pop();
    });
    assert.deepEqual(value.tags, ["z", "b", "c"]);
  });

  it("array splice with insertion", () => {
    const { value } = roundtrip((m) => {
      m.items.splice(1, 0, { id: 3, name: "three" }, { id: 4, name: "four" });
    });
    assert.deepEqual(
      value.items.map((i) => i.id),
      [1, 3, 4, 2]
    );
  });

  it("array reverse and sort", () => {
    const { value } = roundtrip((m) => {
      m.tags.push("c");
      m.tags.reverse();
      m.tags.sort();
    });
    assert.deepEqual(value.tags, ["a", "b", "c"]);
  });

  it("indexed assignment and length truncation", () => {
    const { value } = roundtrip((m) => {
      m.tags[0] = "A";
      m.tags[5] = "F"; // Creates holes (null) in between.
      m.tags.length = 2;
    });
    assert.deepEqual(value.tags, ["A", "b"]);
  });

  it("mutating an element after reordering", () => {
    const { value } = roundtrip((m) => {
      const second = m.items[1];
      m.items.reverse();
      second.name = "renamed";
    });
    // items[0] is the original second element, now renamed.
    assert.strictEqual(value.items[0].name, "renamed");
    assert.strictEqual(value.items[0].id, 2);
  });

  it("many interleaved mutations", () => {
    const { value } = roundtrip((m) => {
      m.title = "Doc";
      m.meta.author = "bob";
      m.meta.nested = { deep: 1 };
      m.meta.nested.deep = 2;
      m.tags.push("c");
      m.items.push({ id: 3, name: "three" });
      m.items[0].name = "first";
      m.tags.splice(0, 1);
    });
    assert.deepEqual(value, {
      type: "doc",
      id: "d1",
      title: "Doc",
      tags: ["b", "c"],
      meta: { author: "bob", views: 0, nested: { deep: 2 } },
      items: [
        { id: 1, name: "first" },
        { id: 2, name: "two" },
        { id: 3, name: "three" },
      ],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Integration with Log2Log.                                                  */
/* -------------------------------------------------------------------------- */

const typeToModel = { doc: docModel };
type TTM = typeof typeToModel;

function newState(): SavedState<TTM> {
  return { doc: [newDoc()] };
}

describe("json-model via Log2Log", () => {
  it("commits mutations to an existing value as updates", () => {
    const log2log = new Log2Log(typeToModel, newState());
    const result = log2log.applyMutations([
      {
        id: "m1",
        apply: (tx) => {
          const doc = tx.getMutable("doc", "d1");
          if (doc === undefined) throw new Error("missing doc");
          doc.title = "Edited";
          doc.tags.push("c");
          doc.items[0].name = "first";
        },
      },
    ]);

    assert.strictEqual(result.errors.size, 0);
    // The change is described via updates (not a blind set).
    assert.isUndefined(result.changes.blindSets.get("doc", "d1"));
    const update = result.changes.updates.get("doc", "d1");
    assert.isDefined(update);
    const expectedUpdates: JsonPatch[] = [
      { op: "replace", path: "/title", value: "Edited" },
      { op: "splice", path: "/tags", index: 2, remove: 0, add: ["c"] },
      { op: "replace", path: "/items/0/name", value: "first" },
    ];
    assert.deepEqual(update!.updates, expectedUpdates);

    // Applying the recorded updates to the original reproduces the saved value.
    const saved = log2log.save().doc[0];
    assert.deepEqual(docModel.applyUpdates(newDoc(), expectedUpdates), saved);
    assert.strictEqual(saved.title, "Edited");
    assert.deepEqual(saved.tags, ["a", "b", "c"]);
    assert.strictEqual(saved.items[0].name, "first");
  });

  it("commits a newly set value as a blind set", () => {
    const log2log = new Log2Log(typeToModel, { doc: [] });
    const fresh = newDoc();
    const result = log2log.applyMutations([
      {
        id: "m1",
        apply: (tx) => {
          const doc = tx.getMutable("doc", "d1", fresh);
          doc.title = "Brand new";
        },
      },
    ]);

    assert.strictEqual(result.errors.size, 0);
    const blind = result.changes.blindSets.get("doc", "d1") as Doc | undefined;
    assert.isDefined(blind);
    assert.strictEqual(blind!.title, "Brand new");
    assert.isUndefined(result.changes.updates.get("doc", "d1"));
  });
});
