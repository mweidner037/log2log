import { BiMap } from "./bi_map";
import {
  BaseTypeToModel,
  BaseValue,
  MutableValue,
  MutableValueType,
  ValueType,
} from "./model";
import { ValueStore } from "./store";
import { Transaction } from "./transaction";

export class Log2Log<TTM extends BaseTypeToModel> {
  constructor(readonly typeToModel: TTM, readonly store: ValueStore<TTM>) {}

  /**
   * Begins a new transaction against the store.
   *
   * Changes made during the transaction are not committed to the store; instead,
   * call {@link TransactionImpl.getChanges} at the end to retrieve them.
   */
  beginTransaction(): TransactionImpl<TTM> {
    return new TransactionImpl(this.typeToModel, this.store);
  }
}

interface TransactionChanges<TTM extends BaseTypeToModel> {
  sets: BiMap<TTM, BaseValue>;
  updates: BiMap<TTM, object[]>;
}

/**
 * A single active mutable value within a transaction.
 */
interface MutableEntry {
  /** The mutable wrapper returned to the caller. */
  mutable: MutableValue<BaseValue, object>;
  /**
   * True if this mutable was derived from a value that already exists in the
   * store, so its changes should be committed as updates. False if the value
   * is new to this transaction (created via {@link TransactionImpl.set} or from
   * an initialValue), so it should be committed as a blind set instead.
   */
  fromStore: boolean;
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
    private readonly store: ValueStore<TTM>
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
    // Otherwise fall through to the store.
    return this.store.get(type, id);
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
    let fromStore: boolean;
    const blind = this.blindSets.get(t, id);
    if (blind !== undefined) {
      // A value set earlier in this transaction; it's new, so commit as a set.
      currentValue = blind;
      fromStore = false;
      this.blindSets.delete(t, id);
    } else {
      const stored = this.store.get(type, id);
      if (stored !== null) {
        currentValue = stored;
        fromStore = true;
      } else if (initialValue !== undefined) {
        currentValue = initialValue;
        fromStore = false;
      } else {
        return null;
      }
    }

    const model = this.typeToModel[t];
    const mutable = model.toMutable(currentValue as ValueType<TTM, K>);
    this.mutables.set(t, id, { mutable, fromStore });
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
    const sets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, object[]>();

    for (const [type, id, value] of this.blindSets.entries()) {
      sets.set(type, id, value);
    }

    for (const [type, id, entry] of this.mutables.entries()) {
      if (entry.fromStore) {
        // An existing value was mutated: commit the changes as updates.
        const u = entry.mutable._getUpdates();
        if (u.length > 0) updates.set(type, id, u);
      } else {
        // A new value (set or created from initialValue): commit the final
        // value as a blind set, even if no further changes were made.
        sets.set(type, id, entry.mutable._toImmutable());
      }
    }

    return { sets, updates };
  }
}
