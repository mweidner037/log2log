import { BiMap } from "./bi-map";
import {
  BaseTypeToModel,
  BaseValue,
  MutableValue,
  MutableValueType,
  ValueType,
} from "./model";
import { SavedState } from "./saved-state";
import { Transaction } from "./transaction";

export class Log2Log<TTM extends BaseTypeToModel> {
  private readonly state = new BiMap<TTM, BaseValue>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {}

  /**
   * Begins a new transaction against the store.
   *
   * Changes made during the transaction are not committed to the store; instead,
   * call {@link TransactionImpl.getChanges} at the end to retrieve them.
   */
  beginTransaction(): TransactionImpl<TTM> {
    return new TransactionImpl(this.typeToModel, this.state);
  }

  /**
   * Applies a single mutation.
   *
   * If the mutation throws, the error propagates and no changes occur.
   */
  applyMutation(mutation: MutationCallback): void {}

  /**
   * Applies a sequence of mutations, updating the store once at the end.
   *
   * Any mutations that throw become no-ops.
   *
   * @returns A boolean for each mutation indicating whether it succeeded
   * (did not throw).
   */
  applyMutations(mutations: MutationCallback[]): boolean[] {}

  /**
   * Returns the current state as a {@link SavedState}, with one array of values
   * per type (empty for types that have no values).
   */
  save(): SavedState<TTM> {
    const result = {} as SavedState<TTM>;
    for (const type of Object.keys(this.typeToModel) as (keyof TTM & string)[]) {
      result[type] = this.state
        .getInner(type)
        .map(([, value]) => value) as SavedState<TTM>[keyof TTM & string];
    }
    return result;
  }
}

interface TransactionChanges<TTM extends BaseTypeToModel> {
  blindSets: BiMap<TTM, BaseValue>;
  updates: BiMap<TTM, [value: BaseValue, updates: object[]]>;
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
  getChanges(): TransactionChanges<TTM> {
    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, [value: BaseValue, updates: object[]]>();

    for (const [type, id, value] of this.blindSets.entries()) {
      blindSets.set(type, id, value);
    }

    for (const [type, id, entry] of this.mutables.entries()) {
      if (entry.fromState) {
        // An existing value was mutated: commit the changes as updates.
        const change = entry.mutable._finish();
        if (change[1].length > 0) updates.set(type, id, change);
      } else {
        // A new value (set or created from initialValue): commit the final
        // value as a blind set, even if no further changes were made.
        blindSets.set(type, id, entry.mutable._toImmutable());
      }
    }

    return { blindSets, updates };
  }
}
