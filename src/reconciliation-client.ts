import { ChangeSet } from "./log2log";
import { BaseTypeToModel, BaseValue, ValueType } from "./model";
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
  private serverState: PersistentBiMap<TTM, BaseValue>;
  private optimisticState: PersistentBiMap<TTM, BaseValue>;
  /** Keyed by mutation id. Iterator order matches the original applyOptimisticMutation order. */
  private pendingMutations = new Map<string, MutationCallback>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {}

  /**
   * Returns the value with the given type and id, or null if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | null {}

  /**
   * Returns the values with the given type and ids.
   *
   * The returned values are in the same order as ids, skipping any ids
   * that do not exist.
   */
  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[] {}

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
    mutation: MutationCallback
  ): BiMap<TTM, BaseValue> {
    // TODO: Update optimisticState without touching serverState.
    // Also
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
    // TODO: Update serverState directly from the changeSet,
    // then rerun pendingMutations on top of it to get the new optimisticState.
    // Remember to swallow errors, and start by processing confirmedMutationIds.
  }
}
