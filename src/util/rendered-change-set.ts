import { BaseTypeToModel, BaseValue } from "../model";
import { BiMap } from "./bi-map";

/**
 * A set of changes to a key-value store, rendered as final values: blind sets
 * (carrying each key's full new value) and deletions.
 *
 * Unlike a {@link ChangeSet}, which records only *what* changed (updates carry
 * just their update objects), a RenderedChangeSet carries each changed key's
 * resulting value, ready to apply directly to a downstream store.
 *
 * Like a {@link ChangeSet}, a RenderedChangeSet can delete keys. Deletions also
 * arise during reconciliation: e.g. an optimistic client mutation may create a
 * value whose authoritative server mutation later fails (becoming a no-op), so
 * the optimistically-created value must be deleted when that mutation is
 * confirmed.
 *
 * `sets` and `deletes` are kept disjoint by {@link recordSet} and
 * {@link recordDelete}: recording a key as one removes it from the other.
 */
export class RenderedChangeSet<TTM extends BaseTypeToModel> {
  constructor(
    /**
     * All values set directly, including new values.
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
}
