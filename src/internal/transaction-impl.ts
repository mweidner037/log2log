import { BiMap } from "../data-structures/bi-map";
import { ChangeSet } from "../data-structures/change-set";
import { RenderedChangeSet } from "../data-structures/rendered-change-set";
import { GetState } from "../types/get-state";
import {
  BaseTypeToModel,
  BaseValue,
  MutableValue,
  MutableValueType,
  ValueType,
} from "../types/model";
import { Transaction } from "../types/transaction";

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

/**
 * Default implementation of {@link Transaction}, accumulating the changes made
 * during a single mutation so that they can be committed via {@link getChanges}.
 */
export class TransactionImpl<TTM extends BaseTypeToModel>
  implements Transaction<TTM>
{
  /**
   * Values written via {@link set} that have not (since) been turned into a
   * mutable or deleted. Committed as blind sets.
   *
   * Invariant: a given (type, id) appears in at most one of
   * blindSets, mutables, or deletes at a time.
   */
  private readonly blindSets = new BiMap<TTM, BaseValue>();
  /** Active mutable values, keyed by (type, id). */
  private readonly mutables = new BiMap<TTM, MutableEntry>();
  /**
   * Deleted values.
   */
  private readonly deletes = new BiMap<TTM, true>();

  constructor(
    private readonly typeToModel: TTM,
    private readonly state: GetState<TTM>
  ) {}

  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | undefined {
    const t = type;

    // A blind set shows up for future reads.
    const blind = this.blindSets.get(t, id);
    if (blind !== undefined) {
      return blind as ValueType<TTM, K>;
    }
    // A mutable's changes show up for future reads.
    const entry = this.mutables.get(t, id);
    if (entry !== undefined) {
      return entry.mutable.__toImmutable() as ValueType<TTM, K>;
    }
    // A deleted value reads as absent, even if it still exists in the state.
    if (this.deletes.has(t, id)) {
      return undefined;
    }
    // Otherwise fall through to the state.
    const stored = this.state.get(t, id);
    return stored as ValueType<TTM, K> | undefined;
  }

  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[] {
    const result: ValueType<TTM, K>[] = [];
    for (const id of ids) {
      const value = this.get(type, id);
      if (value !== undefined) result.push(value);
    }
    return result;
  }

  getMutable<K extends keyof TTM>(
    type: K,
    id: string
  ): MutableValueType<TTM, K> | undefined;
  getMutable<K extends keyof TTM>(
    type: K,
    id: string,
    initialValue: ValueType<TTM, K>
  ): MutableValueType<TTM, K>;
  getMutable<K extends keyof TTM>(
    type: K,
    id: string,
    initialValue?: ValueType<TTM, K>
  ): MutableValueType<TTM, K> | undefined {
    const t = type;

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
      // Get the value from this.state filtered by this.deletes.
      const stored = this.deletes.has(t, id)
        ? undefined
        : this.state.get(t, id);
      if (stored !== undefined) {
        currentValue = stored;
        fromState = true;
      } else if (initialValue !== undefined) {
        // The value is new or was deleted locally.
        // Either way, we need to eventually commit it as a set.
        currentValue = initialValue;
        fromState = false;
      } else {
        return undefined;
      }
    }

    const model = this.typeToModel[t];
    const mutable = model.toMutable(currentValue as ValueType<TTM, K>);
    // Creating a mutable overrides any earlier delete of this key.
    this.deletes.delete(t, id);
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
      if (mutable !== undefined) result.push(mutable);
    }
    return result;
  }

  set<K extends keyof TTM>(value: ValueType<TTM, K>): void {
    const t = value.type;
    // Override any active mutable version: its changes will not be committed.
    this.mutables.delete(t, value.id);
    // A set overrides any earlier delete of this key.
    this.deletes.delete(t, value.id);

    this.blindSets.set(t, value.id, value);
  }

  delete<K extends keyof TTM>(type: K, id: string): void {
    const t = type;
    // Override any pending set or active mutable version: the net effect is a
    // delete, so their changes will not be committed.
    this.blindSets.delete(t, id);
    this.mutables.delete(t, id);

    this.deletes.set(t, id, true);
  }

  /**
   * Returns the changes made during the transaction, as a ChangeSet and
   * RenderedChangeSet.
   *
   * **Warning**: Do not mutate the return values internally, as they share state.
   */
  getChanges(): { changes: ChangeSet<TTM>; rendered: RenderedChangeSet<TTM> } {
    const blindSets = new BiMap<TTM, BaseValue>();
    const updates = new BiMap<TTM, object[]>();
    const allSets = new BiMap<TTM, BaseValue>();

    for (const [type, id, value] of this.blindSets.entries()) {
      blindSets.set(type, id, value);
      allSets.set(type, id, value);
    }

    for (const [type, id, entry] of this.mutables.entries()) {
      if (entry.fromState) {
        // An existing value was mutated: commit the changes as updates, and
        // record its final value (straight from __finish) in allSets.
        const change = entry.mutable.__finish();
        if (change.updates.length > 0) {
          updates.set(type, id, change.updates);
          allSets.set(type, id, change.value);
        }
      } else {
        // A new value (set or created from initialValue): commit the final
        // value as a blind set, even if no further changes were made.
        const value = entry.mutable.__toImmutable();
        blindSets.set(type, id, value);
        allSets.set(type, id, value);
      }
    }

    return {
      changes: new ChangeSet(
        this.typeToModel,
        blindSets,
        updates,
        this.deletes
      ),
      rendered: new RenderedChangeSet(this.typeToModel, allSets, this.deletes),
    };
  }
}
