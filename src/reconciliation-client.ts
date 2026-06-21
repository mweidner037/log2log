import { TransactionImpl } from "./internal/transaction-impl";
import { ChangeSet } from "./log2log";
import { BaseTypeToModel, BaseValue, ValueType } from "./model";
import { Mutation } from "./mutation";
import { SavedState } from "./saved-state";
import { BiMap } from "./util/bi-map";
import { PersistentBiMap } from "./util/persistent-bi-map";

/**
 * The changes to a {@link ReconciliationClient}'s (optimistic) state caused by
 * an operation, as blind sets and deletions.
 *
 * Unlike a server {@link ChangeSet}, a client's optimistic state can lose
 * values: an optimistic mutation may create a value whose authoritative server
 * mutation later fails (becoming a no-op), so the optimistically-created value
 * must be deleted when that mutation is confirmed.
 */
export interface ClientChangeSet<TTM extends BaseTypeToModel> {
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

/**
 * Key-value store replica for a client connected to a Log2Log server.
 *
 * In addition to accepting changes from the server, this class supports optimistic client operations
 * using [server reconciliation](https://mattweidner.com/2024/06/04/server-architectures.html#1-server-reconciliation).
 */
export class ReconciliationClient<TTM extends BaseTypeToModel> {
  /** The latest authoritative state received from the server. */
  private serverState: PersistentBiMap<TTM, BaseValue>;
  /** The server state with all pending local mutations applied on top. */
  private optimisticState: PersistentBiMap<TTM, BaseValue>;
  /**
   * The values that the pending mutations have written on top of the server
   * state, as blind sets of their optimistic values. In other words, the keys
   * where optimisticState may differ from serverState.
   */
  private optimisticChanges = new BiMap<TTM, BaseValue>();
  /** Keyed by mutation id. Iterator order matches the original applyOptimisticMutation order. */
  private pendingMutations = new Map<string, Mutation<TTM>>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {
    // Load the initial state. The optimistic state starts equal to the server
    // state, since there are no pending mutations yet.
    let state = PersistentBiMap.empty<TTM, BaseValue>();
    for (const type of Object.keys(typeToModel) as (keyof TTM & string)[]) {
      const model = typeToModel[type];
      const savedValues = initialState[type];
      if (savedValues === undefined) continue;
      for (const savedValue of savedValues) {
        const value = model.load(savedValue);
        state = state.set(type, value.id, value);
      }
    }
    this.serverState = state;
    this.optimisticState = state;
  }

  /**
   * Returns the value with the given type and id, or undefined if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | undefined {
    const value = this.optimisticState.get(type as keyof TTM & string, id);
    return value as ValueType<TTM, K> | undefined;
  }

  /**
   * Returns the values with the given type and ids.
   *
   * The returned values are in the same order as ids, skipping any ids
   * that do not exist.
   */
  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[] {
    const result: ValueType<TTM, K>[] = [];
    for (const id of ids) {
      const value = this.get(type, id);
      if (value !== undefined) result.push(value);
    }
    return result;
  }

  /**
   * Optimistically applies a mutation by the local client.
   *
   * The mutation is applied on top of the current (optimistic) state.
   * If it throws, nothing changes and the error propagates.
   *
   * The mutation is also stored for later. Future calls to applyServerChanges will rerun
   * it on top of the new server state, until confirmedMutationIds
   * indicate that the new server state already incorporates this mutation's
   * authoritative server changes.
   *
   * @returns The changes to the current (optimistic) state. A mutation can only
   * set values (never delete), so the result has no deletions.
   */
  applyOptimisticMutation(mutation: Mutation<TTM>): ClientChangeSet<TTM> {
    // Run the mutation on top of the current optimistic state. If it throws,
    // the error propagates here before we touch any state, so this is a no-op.
    const transaction = new TransactionImpl(
      this.typeToModel,
      this.optimisticState
    );
    mutation.apply(transaction);

    // The mutation succeeded: commit its changes to the optimistic state and
    // remember it so that it can be rerun against future server states. The
    // changes also extend the optimistic overlay over the server state.
    const sets = new BiMap<TTM, BaseValue>();
    this.optimisticState = this.applyChanges(
      this.optimisticState,
      transaction.getChanges(),
      sets,
      this.optimisticChanges
    );
    this.pendingMutations.set(mutation.id, mutation);
    return { sets, deletes: new Map() };
  }

  /**
   * Applies a ChangeSet received from the server's authoritative key-value store (Log2Log instance).
   * Also confirms the pending local mutations with the given ids,
   * so that they are no longer rerun.
   *
   * If pending local mutations remain after processing confirmedMutationIds,
   * they are rerun on top of the new server state.
   * Any rerun mutations that throw become no-ops.
   *
   * @returns The overall changes to the current *optimistic* state, as blind sets
   * and deletions. These may be broader than necessary (e.g., if rerunning a
   * pending local mutation causes the same changes as its previous run).
   */
  applyServerChanges(
    changeSet: ChangeSet<TTM>,
    confirmedMutationIds: string[]
  ): ClientChangeSet<TTM> {
    // Confirmed mutations are now incorporated into the server state, so they
    // should no longer be rerun.
    for (const id of confirmedMutationIds) {
      this.pendingMutations.delete(id);
    }

    // Apply the server's changes directly to the server state. Accumulate the
    // affected values, which feed into the returned optimistic blind sets.
    const sets = new BiMap<TTM, BaseValue>();
    this.serverState = this.applyChanges(this.serverState, changeSet, sets);

    // Rebuild the optimistic overlay from scratch, remembering the previous one
    // so that we can roll back keys it no longer covers.
    const prevOptimisticChanges = this.optimisticChanges;
    this.optimisticChanges = new BiMap<TTM, BaseValue>();

    // Rerun the remaining pending mutations on top of the new server state to
    // rebuild the optimistic state. A rerun that throws is skipped (a no-op),
    // but stays pending until it is confirmed.
    let optimisticState = this.serverState;
    for (const mutation of this.pendingMutations.values()) {
      const transaction = new TransactionImpl(
        this.typeToModel,
        optimisticState
      );
      try {
        mutation.apply(transaction);
      } catch (error) {
        console.log(
          "Mutation " + mutation.id + " failed when rerunning, skipping",
          error
        );
        continue;
      }
      optimisticState = this.applyChanges(
        optimisticState,
        transaction.getChanges(),
        sets,
        this.optimisticChanges
      );
    }
    this.optimisticState = optimisticState;

    // Roll back keys that were in the old optimistic overlay but are no longer
    // optimistically changed, so a consumer applying the result stays in sync
    // with the new optimistic state. Each such key either reverts to its server
    // value (a blind set) or, if the server has no such value (an optimistically
    // created value whose server mutation was a no-op), is deleted.
    const deletes = new Map<keyof TTM & string, string[]>();
    for (const [type, id] of prevOptimisticChanges.entries()) {
      if (!this.optimisticChanges.has(type, id)) {
        const serverValue = this.serverState.get(type, id);
        if (serverValue !== undefined) {
          sets.set(type, id, serverValue);
        } else {
          const ids = deletes.get(type);
          if (ids === undefined) deletes.set(type, [id]);
          else ids.push(id);
        }
      }
    }

    return { sets, deletes };
  }

  /**
   * Applies the given {@link ChangeSet} to `state`, returning the resulting
   * state. Each affected value is also recorded in every `accumulators` map as
   * a blind set of its final value (later writes override earlier ones).
   */
  private applyChanges(
    state: PersistentBiMap<TTM, BaseValue>,
    changes: ChangeSet<TTM>,
    ...accumulators: BiMap<TTM, BaseValue>[]
  ): PersistentBiMap<TTM, BaseValue> {
    let result = state;
    for (const [type, id, value] of changes.blindSets.entries()) {
      result = result.set(type, id, value);
      for (const acc of accumulators) acc.set(type, id, value);
    }
    for (const [type, id, update] of changes.updates.entries()) {
      result = result.set(type, id, update.value);
      for (const acc of accumulators) acc.set(type, id, update.value);
    }
    return result;
  }
}
