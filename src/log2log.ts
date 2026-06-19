import { TransactionImpl } from "./internal/transaction-impl";
import { BaseTypeToModel, BaseValue } from "./model";
import { MutationCallback } from "./mutation";
import { SavedState } from "./saved-state";
import { BiMap } from "./util/bi-map";

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

export interface ApplyMutationsResult<TTM extends BaseTypeToModel> {
  /**
   * For each mutation applied, null if it succeeded, or the thrown error if it failed.
   */
  errors: unknown[];
  /**
   * The cumulative changes caused by these mutations.
   */
  changes: ChangeSet<TTM>;
}

/**
 * Converts a log of mutations into a log of key-value store changes.
 *
 * In the language of [this article](https://mattweidner.com/2024/06/04/server-architectures.html), Log2Log is designed to help implement a collaboration system that sends _mutations_ (high-level operations, like event sourcing events) from client->server but _state changes_ (low-level operations, like SQL row updates) from server->client.
 *
 * The Log2Log class manages a synchronous in-memory key-value store,
 * accepts mutations to that store (via applyMutations), and changes the store
 * while returning the corresponding ChangeSet.
 * It is designed for use on a central collaboration server.
 */
export class Log2Log<TTM extends BaseTypeToModel> {
  private readonly state = new BiMap<TTM, BaseValue>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {
    // Load the initial state so that mutations can read existing values.
    for (const type of Object.keys(typeToModel) as (keyof TTM & string)[]) {
      const values = initialState[type];
      if (values === undefined) continue;
      for (const value of values) {
        this.state.set(type, value.id, value);
      }
    }
  }

  /**
   * Applies a sequence of mutations, returning their success/failure statuses
   * and the overall changes.
   *
   * Any mutations that throw become no-ops.
   */
  applyMutations(
    mutations: MutationCallback<TTM>[]
  ): ApplyMutationsResult<TTM> {
    const errors: unknown[] = [];
    // The overall changes, accumulated across successful mutations and keyed by
    // (type, id). A given (type, id) is in at most one of these maps.
    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, { value: BaseValue; updates: object[] }>();

    for (const mutation of mutations) {
      const transaction = new TransactionImpl(this.typeToModel, this.state);
      try {
        mutation(transaction);
      } catch (error) {
        // A failed mutation is a no-op: record the error and move on without
        // touching the state or the accumulated changes.
        errors.push(error);
        continue;
      }
      errors.push(null);

      // The mutation succeeded. Apply its changes to this.state so that the
      // next mutation sees them, and fold them into the overall changeSet.
      const changes = transaction.getChanges();

      for (const [type, id, value] of changes.blindSets.entries()) {
        this.state.set(type, id, value);
        // A blind set replaces any prior set and overrides any prior updates.
        updates.delete(type, id);
        blindSets.set(type, id, value);
      }

      for (const [type, id, update] of changes.updates.entries()) {
        this.state.set(type, id, update.value);

        if (blindSets.has(type, id)) {
          // The value was blind-set earlier in this batch, so we can't describe
          // its overall change in terms of updates. Convert them into an
          // updated blind set.
          blindSets.set(type, id, update.value);
        } else {
          const existing = updates.get(type, id);
          if (existing !== undefined) {
            existing.updates.push(...update.updates);
            existing.value = update.value;
          } else {
            updates.set(type, id, {
              value: update.value,
              updates: [...update.updates],
            });
          }
        }
      }
    }

    return { errors, changes: { blindSets, updates } };
  }

  /**
   * Returns the current state as a {@link SavedState}, with one array of values
   * per type (empty for types that have no values).
   */
  save(): SavedState<TTM> {
    const result = {} as SavedState<TTM>;
    for (const type of Object.keys(this.typeToModel) as (keyof TTM &
      string)[]) {
      result[type] = this.state
        .getInner(type)
        .map(([, value]) => value) as SavedState<TTM>[keyof TTM & string];
    }
    return result;
  }
}
