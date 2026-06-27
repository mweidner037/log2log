import * as z from "zod";
import { GetState } from "../types/get-state";
import { BaseTypeToModel, BaseValue } from "../types/model";
import { BiMap } from "./bi-map";
import { BiSet } from "./bi-set";
import { RenderedChangeSet } from "./rendered-change-set";

/**
 * JSON-serializable form of a {@link ChangeSet}.
 */
export type SavedChangeSet = {
  /** Per-type blind sets and updates. */
  values: Record<
    string,
    {
      /** Blind-set values serialized to JSON. */
      blindSets: object[];
      /** Updates keyed by their value's id. */
      updates: { [id: string]: object[] };
    }
  >;
  /** Deletes, mapping type to an array of ids. */
  deletes: Record<string, string[]>;
};

/**
 * Zod schema for SavedChangeSet.
 */
export const zChangeSet: z.ZodType<SavedChangeSet> = z.object({
  values: z.record(
    z.string(),
    z.object({
      blindSets: z.array(z.any()),
      updates: z.record(z.string(), z.array(z.any())),
    })
  ),
  deletes: z.record(z.string(), z.array(z.any())),
});

/**
 * An atomic set of changes to the key-value store, suitable
 * for serialization to send from Log2Log to a ReconciliationReplica.
 */
export class ChangeSet<TTM extends BaseTypeToModel> {
  constructor(
    private readonly typeToModel: TTM,
    /**
     * All values set directly, including new values.
     */
    readonly blindSets: BiMap<TTM, BaseValue> = new BiMap(),
    /**
     * The updates for each value changed via a MutableValue.
     */
    readonly updates: BiMap<TTM, object[]> = new BiMap(),
    /**
     * The deleted keys.
     */
    readonly deletes: BiSet<TTM> = new BiSet()
  ) {}

  /**
   * Applies another ChangeSet on top of this one, modifying this one in-place.
   *
   * @param reject If supplied, rejected keys are skipped when iterating over changeSet.
   */
  apply(
    changeSet: ChangeSet<TTM>,
    reject?: (type: keyof TTM, id: string) => boolean
  ): void {
    for (const [type, id, value] of changeSet.blindSets) {
      if (reject?.(type, id)) continue;

      // A blind set overrides any earlier change to this key.
      this.updates.delete(type, id);
      this.deletes.delete(type, id);

      this.blindSets.set(type, id, value);
    }

    for (const [type, id, valueUpdates] of changeSet.updates) {
      if (reject?.(type, id)) continue;

      // An update overrides an earlier delete of this key.
      this.deletes.delete(type, id);

      const blind = this.blindSets.get(type, id);
      if (blind !== undefined) {
        // The value was set blindly earlier, so it stays a blind set; apply the
        // updates to the blind value to keep its full form current.
        this.blindSets.set(
          type,
          id,
          this.typeToModel[type].applyUpdates(blind, valueUpdates)
        );
      } else {
        let allUpdates = this.updates.get(type, id);
        if (!allUpdates) {
          allUpdates = [];
          this.updates.set(type, id, allUpdates);
        }
        allUpdates.push(...valueUpdates);
      }
    }

    for (const [type, id] of changeSet.deletes) {
      if (reject?.(type, id)) continue;

      // A delete overrides any earlier change to this key.
      this.blindSets.delete(type, id);
      this.updates.delete(type, id);

      this.deletes.add(type, id);
    }
  }

  /**
   * Renders this ChangeSet on top of the given state.
   */
  render(state: GetState<TTM>): RenderedChangeSet<TTM> {
    const rendered = new RenderedChangeSet(this.typeToModel);
    rendered.apply(this, state);
    return rendered;
  }

  save(): SavedChangeSet {
    const values = {} as SavedChangeSet["values"];
    for (const type of Object.keys(this.typeToModel) as (keyof TTM &
      string)[]) {
      const model = this.typeToModel[type];
      const blindSets = this.blindSets
        .getInner(type)
        .map(([, value]) => model.save(value));
      const updates: { [id: string]: object[] } = {};
      for (const [id, valueUpdates] of this.updates.getInner(type)) {
        // Updates are already JSON.
        updates[id] = valueUpdates;
      }
      values[type] = { blindSets, updates };
    }

    const deletes: Record<string, string[]> = {};
    for (const [type, id] of this.deletes) {
      const ids = deletes[type];
      if (ids === undefined) deletes[type] = [id];
      else ids.push(id);
    }

    return { values, deletes };
  }

  static load<TTM extends BaseTypeToModel>(
    typeToModel: TTM,
    saved: SavedChangeSet
  ): ChangeSet<TTM> {
    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, object[]>();
    for (const type of Object.keys(saved.values)) {
      const model = typeToModel[type];
      const entry = saved.values[type];
      for (const savedValue of entry.blindSets) {
        const value = model.load(savedValue);
        blindSets.set(type, value.id, value);
      }
      for (const id of Object.keys(entry.updates)) {
        updates.set(type, id, entry.updates[id]);
      }
    }

    const deletes = new BiSet();
    for (const type of Object.keys(saved.deletes)) {
      const ids = saved.deletes[type];
      for (const id of ids) deletes.add(type, id);
    }

    return new ChangeSet(typeToModel, blindSets, updates, deletes);
  }
}

/**
 * Merges a sequence of ChangeSets into a single ChangeSet with the same net
 * effect, applied in iteration order.
 */
export function mergeChangeSets<TTM extends BaseTypeToModel>(
  typeToModel: TTM,
  changeSets: Iterable<ChangeSet<TTM>>
): ChangeSet<TTM> {
  const ans = new ChangeSet(typeToModel);
  for (const changeSet of changeSets) {
    ans.apply(changeSet);
  }
  return ans;
}
