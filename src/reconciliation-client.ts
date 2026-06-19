import { TransactionImpl } from "./internal/transaction-impl";
import { ChangeSet } from "./log2log";
import { BaseTypeToModel, BaseValue, ValueType } from "./model";
import { MutationCallback } from "./mutation";
import { SavedState } from "./saved-state";
import { BiMap } from "./util/bi-map";
import { PersistentBiMap } from "./util/persistent-bi-map";

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
  /** Keyed by mutation id. Iterator order matches the original applyOptimisticMutation order. */
  private pendingMutations = new Map<string, MutationCallback<TTM>>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {
    // Load the initial state. The optimistic state starts equal to the server
    // state, since there are no pending mutations yet.
    let state = PersistentBiMap.empty<TTM, BaseValue>();
    for (const type of Object.keys(typeToModel) as (keyof TTM & string)[]) {
      const values = initialState[type];
      if (values === undefined) continue;
      for (const value of values) {
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
   * @returns The changes to the current (optimistic) state, as blind sets.
   */
  applyOptimisticMutation(
    id: string,
    mutation: MutationCallback<TTM>
  ): BiMap<TTM, BaseValue> {
    // Run the mutation on top of the current optimistic state. If it throws,
    // the error propagates here before we touch any state, so this is a no-op.
    const transaction = new TransactionImpl(
      this.typeToModel,
      this.optimisticState
    );
    mutation(transaction);

    // The mutation succeeded: commit its changes to the optimistic state and
    // remember it so that it can be rerun against future server states.
    const blindSets = new BiMap<TTM, BaseValue>();
    this.optimisticState = this.applyChanges(
      this.optimisticState,
      transaction.getChanges(),
      blindSets
    );
    this.pendingMutations.set(id, mutation);
    return blindSets;
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
   * @returns The overall changes to the current *optimistic* state, as blind sets.
   * These may be broader than necessary (e.g., if rerunning a pending local mutation
   * causes the same changes as its previous run).
   */
  applyServerChanges(
    changeSet: ChangeSet<TTM>,
    confirmedMutationIds: string[]
  ): BiMap<TTM, BaseValue> {
    // Confirmed mutations are now incorporated into the server state, so they
    // should no longer be rerun.
    for (const id of confirmedMutationIds) {
      this.pendingMutations.delete(id);
    }

    // Apply the server's changes directly to the server state. Accumulate the
    // affected values, which feed into the returned optimistic blind sets.
    const blindSets = new BiMap<TTM, BaseValue>();
    this.serverState = this.applyChanges(
      this.serverState,
      changeSet,
      blindSets
    );

    // Rerun the remaining pending mutations on top of the new server state to
    // rebuild the optimistic state. A rerun that throws is skipped (a no-op),
    // but stays pending until it is confirmed.
    let optimisticState = this.serverState;
    for (const [id, mutation] of this.pendingMutations.entries()) {
      const transaction = new TransactionImpl(
        this.typeToModel,
        optimisticState
      );
      try {
        mutation(transaction);
      } catch (error) {
        console.log(
          "Mutation " + id + " failed when rerunning, skipping",
          error
        );
        continue;
      }
      optimisticState = this.applyChanges(
        optimisticState,
        transaction.getChanges(),
        blindSets
      );
    }
    this.optimisticState = optimisticState;

    return blindSets;
  }

  /**
   * Applies the given {@link ChangeSet} to `state`, returning the resulting
   * state. Each affected value is also recorded in `blindSets` as a blind set
   * of its final value (later writes override earlier ones).
   */
  private applyChanges(
    state: PersistentBiMap<TTM, BaseValue>,
    changes: ChangeSet<TTM>,
    blindSets: BiMap<TTM, BaseValue>
  ): PersistentBiMap<TTM, BaseValue> {
    let result = state;
    for (const [type, id, value] of changes.blindSets.entries()) {
      result = result.set(type, id, value);
      blindSets.set(type, id, value);
    }
    for (const [type, id, update] of changes.updates.entries()) {
      result = result.set(type, id, update.value);
      blindSets.set(type, id, update.value);
    }
    return result;
  }
}
