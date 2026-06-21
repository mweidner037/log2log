import { BaseTypeToModel, BaseValue } from "../model";
import { BiMap } from "./bi-map";

/**
 * JSON-serializable form of a {@link ChangeSet}.
 */
export type SavedChangeSet<TTM extends BaseTypeToModel> = {
  [K in keyof TTM]: {
    /** Blind-set values serialized to JSON. */
    blindSets: object[];
    /** Updates keyed by their value's id. */
    updates: { [id: string]: object[] };
  };
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
    readonly updates: BiMap<TTM, object[]>
  ) {}

  /**
   * Returns the JSON form of this ChangeSet, using each model's save function to
   * convert blind-set values to JSON. (Updates are already JSON.)
   */
  save(): SavedChangeSet<TTM> {
    const result = {} as SavedChangeSet<TTM>;
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
      result[type] = { blindSets, updates };
    }
    return result;
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
    for (const type of Object.keys(saved) as (keyof TTM & string)[]) {
      const model = typeToModel[type];
      const entry = saved[type];
      for (const savedValue of entry.blindSets) {
        const value = model.load(savedValue);
        blindSets.set(type, value.id, value);
      }
      for (const id of Object.keys(entry.updates)) {
        updates.set(type, id, entry.updates[id]);
      }
    }

    return new ChangeSet(typeToModel, blindSets, updates);
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
 */
export function mergeChangeSets<TTM extends BaseTypeToModel>(
  typeToModel: TTM,
  changeSets: Iterable<ChangeSet<TTM>>
): ChangeSet<TTM> {
  const blindSets = new BiMap<TTM, BaseValue>();
  const updates = new BiMap<TTM, object[]>();

  for (const changeSet of changeSets) {
    for (const [type, id, value] of changeSet.blindSets.entries()) {
      // A blind set overrides any earlier change to this key.
      updates.delete(type, id);
      blindSets.set(type, id, value);
    }

    for (const [type, id, valueUpdates] of changeSet.updates.entries()) {
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
  }

  return new ChangeSet(typeToModel, blindSets, updates);
}
