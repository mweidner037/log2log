import { BiSet } from "./data-structures/bi-set";
import { ChangeSet } from "./data-structures/change-set";
import { PersistentBiMap } from "./data-structures/persistent-bi-map";
import { RenderedChangeSet } from "./data-structures/rendered-change-set";
import { TransactionImpl } from "./internal/transaction-impl";
import { BaseTypeToModel, BaseValue, ValueType } from "./types/model";
import { Mutation } from "./types/mutation";
import { SavedState } from "./types/saved-state";

/**
 * Key-value store replica for a client connected to a Log2Log server.
 *
 * In addition to accepting changes from the server, this class supports optimistic client operations
 * using [server reconciliation](https://mattweidner.com/2024/06/04/server-architectures.html#1-server-reconciliation).
 *
 * ## Subscriptions
 *
 * Optionally, the replica may sync only a set of **subscribed** values
 * (partial replication). Its state is then the server's state filtered to include
 * only actively-subscribed values, with optimistic mutations on top as usual.
 * To enable subscriptions:
 * 1. Create a SubscriptionClient alongside this replica
 * connected to a SubscriptionServer.
 * 2. Receive ChangeSets from the SubscriptionServer instead of directly from the server's Log2Log instance.
 * 3. Pass those ChangeSets, together with new active unsubscriptions,
 * to this.applyServerChanges.
 * (Passing unsubscriptions ensures that we delete no-longer-subscribed
 * values from our replica of the server's state, preventing deceptive out-of-date values.)
 */
export class ReconciliationReplica<TTM extends BaseTypeToModel> {
  /** The latest authoritative state received from the server. */
  private serverState: PersistentBiMap<TTM, BaseValue>;
  /** The server state with all pending local mutations applied on top. */
  private optimisticState: PersistentBiMap<TTM, BaseValue>;
  /** Keyed by mutation id. Iterator order matches the original applyOptimisticMutation order. */
  private pendingMutations = new Map<string, Mutation<TTM>>();

  /**
   * The current diff serverState -> optimisticState.
   *
   * Includes optimistic deletes even if redundant, so that such values are
   * considered "known" by SubscriptionClient.
   */
  optimisticDiff: RenderedChangeSet<TTM>;

  constructor(readonly typeToModel: TTM, readonly initialState: SavedState) {
    // Load initial state.
    let state = PersistentBiMap.empty<TTM, BaseValue>();
    for (const type of Object.keys(typeToModel)) {
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
    this.optimisticDiff = new RenderedChangeSet(typeToModel);
  }

  /**
   * Returns the value with the given type and id, or undefined if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | undefined {
    const value = this.optimisticState.get(type, id);
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

    // The mutation succeeded: commit its changes to the optimistic state, and
    // remember it so that it can be rerun against future server states.
    const { rendered } = transaction.getChanges();
    this.optimisticState = changeState(this.optimisticState, rendered);
    this.optimisticDiff.applyRendered(rendered);

    this.pendingMutations.set(mutation.id, mutation);

    return rendered;
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
   * @param unsubscriptions Indicate any values that were unsubscribed
   * along with this ChangeSet, so that we can delete them from our
   * copy of the server state.
   * @returns The overall rendered changes to the current *optimistic* state,
   * including unsubscriptions.
   * These may be broader than necessary (e.g., if rerunning a
   * pending local mutation causes the same changes as its previous run).
   */
  applyServerChanges(
    changeSet: ChangeSet<TTM>,
    confirmedMutationIds: string[],
    unsubscriptions?: BiSet<TTM>
  ): RenderedChangeSet<TTM> {
    // Confirmed mutations are now incorporated into the server state, so they
    // should no longer be rerun.
    for (const id of confirmedMutationIds) {
      this.pendingMutations.delete(id);
    }

    // Overall changes to return, which we build up throughout this method.
    // To start, we invert this.optimisticDiff, corresponding to the first
    // server reconciliation step this.optimisticState -> this.serverState.
    const overallChanges = this.optimisticDiff.invert(this.serverState);

    // Apply the changeSet to this.serverState.
    const serverRendered = changeSet.render(this.serverState);
    this.serverState = changeState(this.serverState, serverRendered);
    overallChanges.applyRendered(serverRendered);

    // Apply the unsubscriptions to this.serverState.
    if (unsubscriptions) {
      for (const [type, id] of unsubscriptions) {
        this.serverState = this.serverState.delete(type, id);
        overallChanges.delete(type, id);
      }
    }

    // Rerun the remaining pending mutations on top of the new server state to
    // rebuild the optimistic state. A rerun that throws is skipped (a no-op),
    // but stays pending until it is confirmed.
    this.optimisticState = this.serverState;
    this.optimisticDiff = new RenderedChangeSet(this.typeToModel);
    for (const mutation of this.pendingMutations.values()) {
      const transaction = new TransactionImpl(
        this.typeToModel,
        this.optimisticState
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

      const { rendered: trRendered } = transaction.getChanges();
      this.optimisticState = changeState(this.optimisticState, trRendered);
      this.optimisticDiff.applyRendered(trRendered);
      overallChanges.applyRendered(trRendered);
    }

    return overallChanges;
  }
}

function changeState<TTM extends BaseTypeToModel>(
  state: PersistentBiMap<TTM, BaseValue>,
  rendered: RenderedChangeSet<TTM>
): PersistentBiMap<TTM, BaseValue> {
  let result = state;
  for (const [type, id, value] of rendered.sets) {
    result = result.set(type, id, value);
  }
  for (const [type, id] of rendered.deletes) {
    result = result.delete(type, id);
  }
  return result;
}
