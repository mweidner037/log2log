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
 * A RenderedChangeSet can also delete keys, which a server {@link ChangeSet}
 * cannot: e.g. an optimistic client mutation may create a value whose
 * authoritative server mutation later fails (becoming a no-op), so the
 * optimistically-created value must be deleted when that mutation is confirmed.
 */
export interface RenderedChangeSet<TTM extends BaseTypeToModel> {
  /**
   * All values set directly, including new values.
   */
  sets: BiMap<TTM, BaseValue>;
  /**
   * The ids deleted, as an array of ids per type name. Types with no deletions
   * are omitted.
   */
  deletes: Map<keyof TTM & string, string[]>;
}
