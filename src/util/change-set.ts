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
  /** Deletes, mapping type to an array of ids. */
  deletes: { [K in keyof TTM]?: string[] };
};

/**
 * An atomic set of changes to the key-value store, suitable
 * for serialization to send from Log2Log to a ReconciliationClient.
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
     * The deleted keys, represented using a set-as-map.
     */
    readonly deletes: BiMap<TTM, true> = new BiMap<TTM, true>()
  ) {}

  /**
   * Applies another ChangeSet on top of this one, modifying this one in-place.
   */
  apply(changeSet: ChangeSet<TTM>): void {
    for (const [type, id, value] of changeSet.blindSets.entries()) {
      // A blind set overrides any earlier change to this key.
      this.updates.delete(type, id);
      this.deletes.delete(type, id);

      this.blindSets.set(type, id, value);
    }

    for (const [type, id, valueUpdates] of changeSet.updates.entries()) {
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

    for (const [type, id] of changeSet.deletes.entries()) {
      // A delete overrides any earlier change to this key.
      this.blindSets.delete(type, id);
      this.updates.delete(type, id);

      this.deletes.set(type, id, true);
    }
  }

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
        // Updates are already JSON.
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
      const ids = saved.deletes[type]!;
      for (const id of ids) deletes.set(type, id, true);
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
  const ans = new ChangeSet(typeToModel, new BiMap(), new BiMap(), new BiMap());
  for (const changeSet of changeSets) {
    ans.apply(changeSet);
  }
  return ans;
}
