import { TransactionImpl } from "./internal/transaction-impl";
import { BaseTypeToModel, BaseValue, ValueType } from "./model";
import { Mutation } from "./mutation";
import { SavedState } from "./saved-state";
import { BiMap } from "./util/bi-map";
import { ChangeSet } from "./util/change-set";
import { PersistentBiMap } from "./util/persistent-bi-map";
import { RenderedChangeSet } from "./util/rendered-change-set";

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
   * The optimistic overlay over the server state: the keys that the pending
   * mutations have set (as blind sets of their optimistic values) or deleted.
   * In other words, the keys where optimisticState may differ from serverState.
   */
  private optimisticOverlay = new RenderedChangeSet<TTM>();
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
   * @returns The changes to the current (optimistic) state, as blind sets and
   * deletions.
   */
  applyOptimisticMutation(mutation: Mutation<TTM>): RenderedChangeSet<TTM> {
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
    const result = new RenderedChangeSet<TTM>();
    const { changes, allSets } = transaction.getChanges();
    this.optimisticState = this.applyOverlay(
      this.optimisticState,
      allSets,
      changes.deletes,
      result,
      this.optimisticOverlay
    );
    this.pendingMutations.set(mutation.id, mutation);
    return result;
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
  ): RenderedChangeSet<TTM> {
    // Confirmed mutations are now incorporated into the server state, so they
    // should no longer be rerun.
    for (const id of confirmedMutationIds) {
      this.pendingMutations.delete(id);
    }

    // Apply the server's changes directly to the server state. Accumulate the
    // affected keys, which feed into the returned optimistic changes.
    const result = new RenderedChangeSet<TTM>();
    this.serverState = this.applyChanges(this.serverState, changeSet, result);

    // Rebuild the optimistic overlay from scratch, remembering the previous one
    // so that we can roll back keys it no longer covers.
    const prevOverlay = this.optimisticOverlay;
    this.optimisticOverlay = new RenderedChangeSet<TTM>();

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
      const { changes, allSets } = transaction.getChanges();
      optimisticState = this.applyOverlay(
        optimisticState,
        allSets,
        changes.deletes,
        result,
        this.optimisticOverlay
      );
    }
    this.optimisticState = optimisticState;

    // Roll back keys that the old optimistic overlay covered (as a set or a
    // delete) but the new one no longer does, so a consumer applying the result
    // stays in sync with the new optimistic state. Each such key either reverts
    // to its server value (a blind set) or, if the server has no such value
    // (e.g. an optimistically created value whose server mutation was a no-op),
    // is deleted.
    for (const prev of [prevOverlay.sets, prevOverlay.deletes]) {
      for (const [type, id] of prev.entries()) {
        if (
          this.optimisticOverlay.sets.has(type, id) ||
          this.optimisticOverlay.deletes.has(type, id)
        ) {
          continue;
        }
        const serverValue = this.serverState.get(type, id);
        if (serverValue !== undefined) {
          result.recordSet(type, id, serverValue);
        } else {
          result.recordDelete(type, id);
        }
      }
    }

    return result;
  }

  /**
   * Applies the given final values (e.g. a transaction's `allSets`) and
   * deletions to `state`, returning the resulting state. Each change is also
   * recorded in every `overlays` entry (later changes override earlier ones,
   * and sets and deletions stay disjoint).
   */
  private applyOverlay(
    state: PersistentBiMap<TTM, BaseValue>,
    sets: BiMap<TTM, BaseValue>,
    deletes: BiMap<TTM, true>,
    ...overlays: RenderedChangeSet<TTM>[]
  ): PersistentBiMap<TTM, BaseValue> {
    let result = state;
    for (const [type, id, value] of sets.entries()) {
      result = result.set(type, id, value);
      for (const overlay of overlays) overlay.recordSet(type, id, value);
    }
    for (const [type, id] of deletes.entries()) {
      result = result.delete(type, id);
      for (const overlay of overlays) overlay.recordDelete(type, id);
    }
    return result;
  }

  /**
   * Applies the given {@link ChangeSet} to `state`, returning the resulting
   * state. Each affected key is also recorded in `overlay` as a blind set of
   * its final value or as a deletion (later changes override earlier ones, and
   * sets and deletions stay disjoint).
   */
  private applyChanges(
    state: PersistentBiMap<TTM, BaseValue>,
    changes: ChangeSet<TTM>,
    overlay: RenderedChangeSet<TTM>
  ): PersistentBiMap<TTM, BaseValue> {
    let result = state;
    for (const [type, id, value] of changes.blindSets.entries()) {
      result = result.set(type, id, value);
      overlay.recordSet(type, id, value);
    }
    for (const [type, id, valueUpdates] of changes.updates.entries()) {
      // The ChangeSet records only the update objects, so recover the final
      // value by applying them to the current value.
      const prev = result.get(type, id);
      if (prev === undefined) continue;
      const value = this.typeToModel[type].applyUpdates(prev, valueUpdates);
      result = result.set(type, id, value);
      overlay.recordSet(type, id, value);
    }
    for (const [type, id] of changes.deletes.entries()) {
      result = result.delete(type, id);
      overlay.recordDelete(type, id);
    }
    return result;
  }
}
