import { BaseTypeToModel, BaseValue } from "../model";
import { BiMap } from "./bi-map";

/**
 * An atomic set of changes to the key-value store.
 */
export interface ChangeSet<TTM extends BaseTypeToModel> {
  /**
   * All values set directly, including new values.
   */
  blindSets: BiMap<TTM, BaseValue>;
  /**
   * All values changed via a MutableValue, storing the
   * final value and its updates.
   */
  updates: BiMap<TTM, { value: BaseValue; updates: object[] }>;
}

/**
 * Merges a sequence of ChangeSets into a single ChangeSet with the same net
 * effect, applied in iteration order.
 *
 * For a given (type, id), a later change overrides an earlier one as follows:
 * - A blind set replaces any earlier change.
 * - An update following a blind set keeps the entry a blind set, taking the
 *   update's final value (the value was new, so its full form is reported).
 * - An update following an update concatenates their update lists and takes the
 *   later final value.
 */
export function mergeChangeSets<TTM extends BaseTypeToModel>(
  changeSets: Iterable<ChangeSet<TTM>>
): ChangeSet<TTM> {
  const blindSets = new BiMap<TTM, BaseValue>();
  const updates = new BiMap<TTM, { value: BaseValue; updates: object[] }>();

  for (const changeSet of changeSets) {
    for (const [type, id, value] of changeSet.blindSets.entries()) {
      // A blind set overrides any earlier change to this key.
      updates.delete(type, id);
      blindSets.set(type, id, value);
    }

    for (const [type, id, update] of changeSet.updates.entries()) {
      if (blindSets.has(type, id)) {
        // The value was set blindly earlier, so it stays a blind set; record
        // the update's final value as the new full value.
        blindSets.set(type, id, update.value);
      } else {
        const prior = updates.get(type, id);
        if (prior === undefined) {
          updates.set(type, id, {
            value: update.value,
            updates: [...update.updates],
          });
        } else {
          updates.set(type, id, {
            value: update.value,
            updates: [...prior.updates, ...update.updates],
          });
        }
      }
    }
  }

  return { blindSets, updates };
}
