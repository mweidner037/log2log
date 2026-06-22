import { BaseTypeToModel, BaseValue } from "../model";
import { BiMap } from "./bi-map";

/**
 * JSON-serializable form of a {@link ChangeSet}.
 */
export type SavedChangeSet<TTM extends BaseTypeToModel> = {
  /** Per-type blind sets and updates. */
  values: {
    [K in keyof TTM]: {
      /** Blind-set values serialized to JSON. */
      blindSets: object[];
      /** Updates keyed by their value's id. */
      updates: { [id: string]: object[] };
    };
  };
  /**
   * Deleted ids per type name: the Record form of the in-memory `deletes` Map
   * (see {@link ChangeSet.deletes}). Types with no deletions are omitted.
   */
  deletes: { [K in keyof TTM]?: string[] };
};

/**
 * An atomic, minimal description of the changes to the key-value store.
 *
 * It records *what* changed but not the resulting values: blind sets carry the
 * full new value, while updates carry only their update objects. The final
 * value of an updated key can be recovered by applying its updates to the
 * previous value (see {@link Log2Log.applyMutations}'s `rendered`).
 */
export class ChangeSet<TTM extends BaseTypeToModel> {
  constructor(
    private readonly typeToModel: TTM,
    /**
     * All values set directly, including new values.
     */
    readonly blindSets: BiMap<TTM, BaseValue>,
    /**
     * The updates for each value changed via a MutableValue.
     */
    readonly updates: BiMap<TTM, object[]>,
    /**
     * The deleted keys. Uses the same format as a {@link RenderedChangeSet}'s
     * `deletes`.
     */
    readonly deletes: BiMap<TTM, true> = new BiMap<TTM, true>()
  ) {}

  /**
   * Returns the JSON form of this ChangeSet, using each model's save function to
   * convert blind-set values to JSON. (Updates are already JSON.)
   */
  save(): SavedChangeSet<TTM> {
    const values = {} as SavedChangeSet<TTM>["values"];
    for (const type of Object.keys(this.typeToModel) as (keyof TTM &
      string)[]) {
      const model = this.typeToModel[type];
      const blindSets = this.blindSets
        .getInner(type)
        .map(([, value]) => model.save(value));
      const updates: { [id: string]: object[] } = {};
      for (const [id, valueUpdates] of this.updates.getInner(type)) {
        updates[id] = valueUpdates;
      }
      values[type] = { blindSets, updates };
    }

    const deletes: { [K in keyof TTM]?: string[] } = {};
    for (const [type, id] of this.deletes.entries()) {
      const ids = deletes[type];
      if (ids === undefined) deletes[type] = [id];
      else ids.push(id);
    }

    return { values, deletes };
  }

  /**
   * Inverse of {@link save}: reconstructs a ChangeSet from its JSON form, using
   * each model's load function to convert blind-set values back from JSON. Each
   * blind-set value's id is read from the loaded value itself.
   */
  static load<TTM extends BaseTypeToModel>(
    typeToModel: TTM,
    json: object
  ): ChangeSet<TTM> {
    const saved = json as SavedChangeSet<TTM>;

    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, object[]>();
    for (const type of Object.keys(saved.values) as (keyof TTM & string)[]) {
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

    const deletes = new BiMap<TTM, true>();
    for (const type of Object.keys(saved.deletes) as (keyof TTM & string)[]) {
      const ids = saved.deletes[type];
      if (ids !== undefined) {
        for (const id of ids) deletes.set(type, id, true);
      }
    }

    return new ChangeSet(typeToModel, blindSets, updates, deletes);
  }
}

/**
 * Merges a sequence of ChangeSets into a single ChangeSet with the same net
 * effect, applied in iteration order.
 *
 * `typeToModel` is used to construct the result (e.g. when `changeSets` is
 * empty) and to apply updates onto blind sets.
 *
 * For a given (type, id), a later change overrides an earlier one as follows:
 * - A blind set replaces any earlier change.
 * - An update following a blind set keeps the entry a blind set, with the
 *   updates applied to the blind value (the value was new, so its full form is
 *   reported).
 * - An update following an update concatenates their update lists.
 * - A delete replaces any earlier change, and is itself replaced by a later
 *   blind set or update.
 */
export function mergeChangeSets<TTM extends BaseTypeToModel>(
  typeToModel: TTM,
  changeSets: Iterable<ChangeSet<TTM>>
): ChangeSet<TTM> {
  const blindSets = new BiMap<TTM, BaseValue>();
  const updates = new BiMap<TTM, object[]>();
  // A BiMap deduplicates repeated deletes of the same key automatically.
  const deletes = new BiMap<TTM, true>();

  for (const changeSet of changeSets) {
    for (const [type, id, value] of changeSet.blindSets.entries()) {
      // A blind set overrides any earlier change to this key.
      updates.delete(type, id);
      deletes.delete(type, id);
      blindSets.set(type, id, value);
    }

    for (const [type, id, valueUpdates] of changeSet.updates.entries()) {
      // An update overrides an earlier delete of this key.
      deletes.delete(type, id);
      const blind = blindSets.get(type, id);
      if (blind !== undefined) {
        // The value was set blindly earlier, so it stays a blind set; apply the
        // updates to the blind value to keep its full form current.
        blindSets.set(
          type,
          id,
          typeToModel[type].applyUpdates(blind, valueUpdates)
        );
      } else {
        const prior = updates.get(type, id);
        updates.set(
          type,
          id,
          prior === undefined ? [...valueUpdates] : [...prior, ...valueUpdates]
        );
      }
    }

    for (const [type, id] of changeSet.deletes.entries()) {
      // A delete overrides any earlier change to this key.
      blindSets.delete(type, id);
      updates.delete(type, id);
      deletes.set(type, id, true);
    }
  }

  return new ChangeSet(typeToModel, blindSets, updates, deletes);
}
