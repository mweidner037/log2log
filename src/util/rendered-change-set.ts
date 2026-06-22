import { BaseTypeToModel, BaseValue } from "../model";
import { BiMap } from "./bi-map";
import { ChangeSet } from "./change-set";

/**
 * An atomic set of changes to the key-value store, "rendered"
 * as sets and deletes instead of distinguishing blindSets from updates.
 *
 * Compared to ChangeSet, a RenderedChangeSet is more convenient for
 * moving changes around in memory but less efficient to send over the network.
 */
export class RenderedChangeSet<TTM extends BaseTypeToModel> {
  constructor(
    private readonly typeToModel: TTM,
    /**
     * All values set directly, including new values.
     *
     * Unlike ChangeSet.blindSets, this also includes updated values' final forms.
     */
    readonly sets: BiMap<TTM, BaseValue> = new BiMap<TTM, BaseValue>(),
    /**
     * The deleted keys.
     */
    readonly deletes: BiMap<TTM, true> = new BiMap<TTM, true>()
  ) {}

  /** Records (type, id) as a set of `value`, clearing any deletion of it. */
  recordSet(type: keyof TTM & string, id: string, value: BaseValue): void {
    this.sets.set(type, id, value);
    this.deletes.delete(type, id);
  }

  /** Records (type, id) as a deletion, clearing any set of it. */
  recordDelete(type: keyof TTM & string, id: string): void {
    this.deletes.set(type, id, true);
    this.sets.delete(type, id);
  }

  /**
   * Applies a RenderedChangeSet on top of this, modifying this in-place.
   */
  applyRendered(rendered: RenderedChangeSet<TTM>): void {
    for (const [type, id, value] of rendered.sets.entries()) {
      this.recordSet(type, id, value);
    }

    for (const [type, id] of rendered.deletes.entries()) {
      this.recordDelete(type, id);
    }
  }

  // TODO: Delete if unused.
  /**
   * Applies a {@link ChangeSet} on top of this one, modifying this in-place.
   *
   * You must supply the state of the key-value store either before or after
   * the current state of the RenderedChangeSet, so that we can process updates
   * to values that we have not changed.
   */
  apply(
    changeSet: ChangeSet<TTM>,
    state: {
      /**
       * Gets the value at (type, id), or undefined if not present.
       */
      get(type: keyof TTM & string, id: string): BaseValue | undefined;
    }
  ): void {
    for (const [type, id, value] of changeSet.blindSets.entries()) {
      this.recordSet(type, id, value);
    }

    for (const [type, id, valueUpdates] of changeSet.updates.entries()) {
      // The ChangeSet records only the update objects, so recover the final
      // value by applying them to this set's current value for the key.
      let currentValue = this.sets.get(type, id);
      if (!currentValue && !this.deletes.has(type, id)) {
        // We haven't touched this value. Look it up in the store instead.
        currentValue = state.get(type, id);
      }
      if (currentValue === undefined) {
        throw new Error(
          `Attempted to apply ChangeSet update to value with type ${type} and id ${id}, but it does not exist`
        );
      }

      this.recordSet(
        type,
        id,
        this.typeToModel[type].applyUpdates(currentValue, valueUpdates)
      );
    }

    for (const [type, id] of changeSet.deletes.entries()) {
      this.recordDelete(type, id);
    }
  }
}
