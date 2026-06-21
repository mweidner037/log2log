import { assert } from "chai";
import { describe, it } from "mocha";

import * as z from "zod";
import { defineJsonModel, JsonModelValue } from "../../src/models/json-model";

/* -------------------------------------------------------------------------- */
/* Sample type.                                                               */
/* -------------------------------------------------------------------------- */

const docSchema = z.object({
  type: z.literal("doc"),
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  meta: z.object({
    author: z.string(),
    views: z.int(),
    nested: z.optional(z.object({ deep: z.number() })),
  }),
  items: z.array(z.object({ id: z.number(), name: z.string() })),
});
type Doc = JsonModelValue<typeof docSchema>;

const model = defineJsonModel(docSchema);

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

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe("json-model proxy", () => {
  describe("reads like a plain object", () => {
    it("exposes the original properties", () => {
      const m = model.toMutable(newDoc());
      assert.strictEqual(m.type, "doc");
      assert.strictEqual(m.id, "d1");
      assert.strictEqual(m.title, "Hello");
      assert.deepEqual(m.tags, ["a", "b"]);
      assert.strictEqual(m.meta.author, "alice");
      assert.strictEqual(m.items[0].name, "one");
    });

    it("hides the MutableValue methods from JSON/keys/spread", () => {
      const m = model.toMutable(newDoc());
      assert.deepEqual(JSON.parse(JSON.stringify(m)), newDoc());
      assert.deepEqual(Object.keys(m), [
        "type",
        "id",
        "title",
        "tags",
        "meta",
        "items",
      ]);
      const spread = { ...m };
      assert.notProperty(spread, "__finish");
      assert.notProperty(spread, "__toImmutable");
    });

    it("returns stable proxies for nested containers", () => {
      const m = model.toMutable(newDoc());
      assert.strictEqual(m.meta, m.meta);
      assert.strictEqual(m.items, m.items);
      assert.strictEqual(m.items[0], m.items[0]);
    });
  });

  describe("object mutations", () => {
    it("records a replace for an existing property", () => {
      const m = model.toMutable(newDoc());
      m.title = "Goodbye";
      assert.strictEqual(m.title, "Goodbye");
      assert.deepEqual(m.__finish().updates, [
        { op: "replace", path: "/title", value: "Goodbye" },
      ]);
    });

    it("records an add for a new property", () => {
      const m = model.toMutable(newDoc());
      m.meta.nested = { deep: 5 };
      assert.deepEqual(m.__finish().updates, [
        { op: "add", path: "/meta/nested", value: { deep: 5 } },
      ]);
    });

    it("records a remove for a deleted property", () => {
      const m = model.toMutable(newDoc());
      delete m.meta.nested;
      // Deleting an absent property is a no-op.
      assert.deepEqual(m.__finish().updates, []);

      const m2 = model.toMutable(newDoc());
      m2.meta.nested = { deep: 1 };
      delete m2.meta.nested;
      assert.deepEqual(m2.__finish().updates, [
        { op: "add", path: "/meta/nested", value: { deep: 1 } },
        { op: "remove", path: "/meta/nested" },
      ]);
    });

    it("records nested-object mutations with full paths", () => {
      const m = model.toMutable(newDoc());
      m.meta.views = 42;
      m.items[1].name = "TWO";
      assert.deepEqual(m.__finish().updates, [
        { op: "replace", path: "/meta/views", value: 42 },
        { op: "replace", path: "/items/1/name", value: "TWO" },
      ]);
    });
  });

  describe("array mutations", () => {
    it("push appends via a splice op", () => {
      const m = model.toMutable(newDoc());
      const len = m.tags.push("c", "d");
      assert.strictEqual(len, 4);
      assert.deepEqual(m.tags, ["a", "b", "c", "d"]);
      assert.deepEqual(m.__finish().updates, [
        { op: "splice", path: "/tags", index: 2, remove: 0, add: ["c", "d"] },
      ]);
    });

    it("pop removes via a splice op", () => {
      const m = model.toMutable(newDoc());
      const removed = m.tags.pop();
      assert.strictEqual(removed, "b");
      assert.deepEqual(m.__finish().updates, [
        { op: "splice", path: "/tags", index: 1, remove: 1, add: [] },
      ]);
    });

    it("shift and unshift use splice ops at index 0", () => {
      const m = model.toMutable(newDoc());
      m.tags.shift();
      m.tags.unshift("z");
      assert.deepEqual(m.tags, ["z", "b"]);
      assert.deepEqual(m.__finish().updates, [
        { op: "splice", path: "/tags", index: 0, remove: 1, add: [] },
        { op: "splice", path: "/tags", index: 0, remove: 0, add: ["z"] },
      ]);
    });

    it("splice records index, remove count, and inserted values", () => {
      const m = model.toMutable(newDoc());
      const removed = m.items.splice(1, 1, { id: 9, name: "nine" });
      assert.deepEqual(removed, [{ id: 2, name: "two" }]);
      assert.deepEqual(m.__finish().updates, [
        {
          op: "splice",
          path: "/items",
          index: 1,
          remove: 1,
          add: [{ id: 9, name: "nine" }],
        },
      ]);
    });

    it("indexed assignment in range is a replace", () => {
      const m = model.toMutable(newDoc());
      m.tags[0] = "A";
      assert.deepEqual(m.__finish().updates, [
        { op: "replace", path: "/tags/0", value: "A" },
      ]);
    });

    it("indexed assignment at the end is a splice append", () => {
      const m = model.toMutable(newDoc());
      m.tags[2] = "c";
      assert.deepEqual(m.tags, ["a", "b", "c"]);
      assert.deepEqual(m.__finish().updates, [
        { op: "splice", path: "/tags", index: 2, remove: 0, add: ["c"] },
      ]);
    });

    it("reverse and sort emit a whole-array replace", () => {
      const m = model.toMutable(newDoc());
      m.tags.reverse();
      assert.deepEqual(m.__finish().updates, [
        { op: "replace", path: "/tags", value: ["b", "a"] },
      ]);
    });

    it("shrinking length emits a splice removal", () => {
      const m = model.toMutable(newDoc());
      m.tags.length = 1;
      assert.deepEqual(m.tags, ["a"]);
      assert.deepEqual(m.__finish().updates, [
        { op: "splice", path: "/tags", index: 1, remove: 1, add: [] },
      ]);
    });

    it("keeps paths correct after a reordering", () => {
      const m = model.toMutable(newDoc());
      // Hold a proxy to an element, then shift it to a new index.
      const second = m.items[1];
      m.items.shift();
      // The same logical element is now at index 0; mutating it must use /items/0.
      second.name = "moved";
      const updates = m.__finish().updates;
      assert.deepEqual(updates[updates.length - 1], {
        op: "replace",
        path: "/items/0/name",
        value: "moved",
      });
    });
  });

  describe("snapshots", () => {
    it("__toImmutable is isolated from later mutations", () => {
      const m = model.toMutable(newDoc());
      m.title = "v1";
      const snapshot = m.__toImmutable();
      m.title = "v2";
      m.tags.push("c");
      assert.strictEqual(snapshot.title, "v1");
      assert.deepEqual(snapshot.tags, ["a", "b"]);
    });

    it("__finish returns the final value plus all updates", () => {
      const m = model.toMutable(newDoc());
      m.title = "Final";
      m.tags.push("c");
      const { value, updates } = m.__finish();
      assert.strictEqual(value.title, "Final");
      assert.deepEqual(value.tags, ["a", "b", "c"]);
      assert.lengthOf(updates, 2);
    });

    it("input value is not mutated", () => {
      const original = newDoc();
      const m = model.toMutable(original);
      m.title = "changed";
      m.tags.push("c");
      m.items[0].name = "changed";
      assert.deepEqual(original, newDoc());
    });
  });
});
