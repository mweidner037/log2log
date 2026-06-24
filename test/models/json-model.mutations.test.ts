import { assert } from "chai";
import { describe, it } from "mocha";

import * as z from "zod";
import { Log2Log } from "../../src/log2log";
import {
  JsonModelValue,
  JsonPatchExtended,
  defineJsonModel,
} from "../../src/models/json-model";
import { SavedState } from "../../src/types/saved-state";

/* -------------------------------------------------------------------------- */
/* Sample type and model.                                                     */
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

const docModel = defineJsonModel(docSchema);

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

const typeToModel = { doc: docModel };

function newState(): SavedState {
  return { doc: [newDoc()] };
}

/* -------------------------------------------------------------------------- */
/* Integration with Log2Log.                                                  */
/* -------------------------------------------------------------------------- */

describe("json-model via Log2Log", () => {
  it("commits mutations to an existing value as updates", () => {
    const log2log = new Log2Log(typeToModel, newState());
    const {
      results: [result],
    } = log2log.applyMutations([
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

    assert.isTrue(result.isSuccess);
    if (!result.isSuccess) throw new Error("unreachable");
    // The change is described via updates (not a blind set).
    assert.isUndefined(result.changes.blindSets.get("doc", "d1"));
    const update = result.changes.updates.get("doc", "d1");
    assert.isDefined(update);
    const expectedUpdates: JsonPatchExtended[] = [
      { op: "replace", path: "/title", value: "Edited" },
      { op: "splice", path: "/tags", index: 2, remove: 0, add: ["c"] },
      { op: "replace", path: "/items/0/name", value: "first" },
    ];
    assert.deepEqual(update, expectedUpdates);

    // Applying the recorded updates to the original reproduces the saved value.
    const saved = log2log.save().doc[0] as Doc;
    assert.deepEqual(docModel.applyUpdates(newDoc(), expectedUpdates), saved);
    assert.strictEqual(saved.title, "Edited");
    assert.deepEqual(saved.tags, ["a", "b", "c"]);
    assert.strictEqual(saved.items[0].name, "first");
  });

  it("commits a newly set value as a blind set", () => {
    const log2log = new Log2Log(typeToModel, { doc: [] });
    const fresh = newDoc();
    const {
      results: [result],
    } = log2log.applyMutations([
      {
        id: "m1",
        apply: (tx) => {
          const doc = tx.getMutable("doc", "d1", fresh);
          doc.title = "Brand new";
        },
      },
    ]);

    assert.isTrue(result.isSuccess);
    if (!result.isSuccess) throw new Error("unreachable");
    const blind = result.changes.blindSets.get("doc", "d1") as Doc | undefined;
    assert.isDefined(blind);
    assert.strictEqual(blind!.title, "Brand new");
    assert.isUndefined(result.changes.updates.get("doc", "d1"));
  });
});
