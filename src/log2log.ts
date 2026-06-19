import {
  BaseTypeToModel,
  BaseValue,
  MutableValue,
  MutableValueType,
  ValueType,
} from "./model";
import { MutationCallback } from "./mutation";
import { SavedState } from "./saved-state";
import { Transaction } from "./transaction";
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

/**
 * A single active mutable value within a transaction.
 */
interface MutableEntry {
  /** The mutable wrapper returned to the caller. */
  mutable: MutableValue<BaseValue, object>;
  /**
   * True if this mutable was derived from a value that already exists in the
   * state, so its changes should be committed as updates. False if the value
   * is new to this transaction (created via {@link TransactionImpl.set} or from
   * an initialValue), so it should be committed as a blind set instead.
   */
  fromState: boolean;
}

class TransactionImpl<TTM extends BaseTypeToModel> implements Transaction<TTM> {
  /**
   * Values written via {@link set} that have not (since) been turned into a
   * mutable. Committed as blind sets.
   *
   * Invariant: a given (type, id) appears in at most one of `blindSets` and
   * `mutables` at a time.
   */
  private readonly blindSets = new BiMap<TTM, BaseValue>();
  /** Active mutable values, keyed by (type, id). */
  private readonly mutables = new BiMap<TTM, MutableEntry>();

  constructor(
    private readonly typeToModel: TTM,
    private readonly state: BiMap<TTM, BaseValue>
  ) {}

  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | null {
    const t = type as keyof TTM & string;

    // A mutable's changes show up for future reads.
    const entry = this.mutables.get(t, id);
    if (entry !== undefined) {
      return entry.mutable._toImmutable() as ValueType<TTM, K>;
    }
    // A blind set shows up for future reads.
    const blind = this.blindSets.get(t, id);
    if (blind !== undefined) {
      return blind as ValueType<TTM, K>;
    }
    // Otherwise fall through to the state.
    const stored = this.state.get(t, id);
    return stored === undefined ? null : (stored as ValueType<TTM, K>);
  }

  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[] {
    const result: ValueType<TTM, K>[] = [];
    for (const id of ids) {
      const value = this.get(type, id);
      if (value !== null) result.push(value);
    }
    return result;
  }

  getMutable<K extends keyof TTM>(
    type: K,
    id: string
  ): MutableValueType<TTM, K> | null;
  getMutable<K extends keyof TTM>(
    type: K,
    id: string,
    initialValue: ValueType<TTM, K>
  ): MutableValueType<TTM, K>;
  getMutable<K extends keyof TTM>(
    type: K,
    id: string,
    initialValue?: ValueType<TTM, K>
  ): MutableValueType<TTM, K> | null {
    const t = type as keyof TTM & string;

    // If we already have a mutable for this value, return the same one.
    const existing = this.mutables.get(t, id);
    if (existing !== undefined) {
      return existing.mutable as MutableValueType<TTM, K>;
    }

    // Determine the value to wrap and how it should ultimately be committed.
    let currentValue: BaseValue;
    let fromState: boolean;
    const blind = this.blindSets.get(t, id);
    if (blind !== undefined) {
      // A value set earlier in this transaction; it's new, so commit as a set.
      currentValue = blind;
      fromState = false;
      this.blindSets.delete(t, id);
    } else {
      const stored = this.state.get(t, id);
      if (stored !== undefined) {
        currentValue = stored;
        fromState = true;
      } else if (initialValue !== undefined) {
        currentValue = initialValue;
        fromState = false;
      } else {
        return null;
      }
    }

    const model = this.typeToModel[t];
    const mutable = model.toMutable(currentValue as ValueType<TTM, K>);
    this.mutables.set(t, id, { mutable, fromState });
    return mutable as MutableValueType<TTM, K>;
  }

  getAllMutable<K extends keyof TTM>(
    type: K,
    ids: string[]
  ): MutableValueType<TTM, K>[] {
    const result: MutableValueType<TTM, K>[] = [];
    for (const id of ids) {
      const mutable = this.getMutable(type, id);
      if (mutable !== null) result.push(mutable);
    }
    return result;
  }

  set<K extends keyof TTM>(value: ValueType<TTM, K>): void {
    const t = value.type as keyof TTM & string;
    // Override any active mutable version: its changes will not be committed.
    this.mutables.delete(t, value.id);
    this.blindSets.set(t, value.id, value);
  }

  /**
   * Returns all changes made during the transaction: blind sets (full values)
   * and updates (lists of update objects) for changes to mutable values.
   */
  getChanges(): ChangeSet<TTM> {
    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, { value: BaseValue; updates: object[] }>();

    for (const [type, id, value] of this.blindSets.entries()) {
      blindSets.set(type, id, value);
    }

    for (const [type, id, entry] of this.mutables.entries()) {
      if (entry.fromState) {
        // An existing value was mutated: commit the changes as updates.
        const change = entry.mutable._finish();
        if (change.updates.length > 0) updates.set(type, id, change);
      } else {
        // A new value (set or created from initialValue): commit the final
        // value as a blind set, even if no further changes were made.
        blindSets.set(type, id, entry.mutable._toImmutable());
      }
    }

    return { blindSets, updates };
  }
}
