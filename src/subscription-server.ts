import { BiMap } from "./data-structures/bi-map";
import { ChangeSet } from "./data-structures/change-set";
import { SubscriptionDelta } from "./data-structures/subscription-delta";
import { GetState } from "./types/get-state";
import { BaseTypeToModel } from "./types/model";

// TODO: on the server, wait to ack sub deletes until you have a real change.
// TODO: caller rate limiting:
// - Rate limit subscription deltas at endpoint, merging them as they come in.
// - Hold back subscription deletes until the next processChanges call.
// - Process subscription adds immediately in this process.
// - Batch ChangeSets in the Log2Log service, merging them before distributing
// to SubscriptionServers.
// - Process ChangeSets immediately in this process.

export class SubscriptionServer<TTM extends BaseTypeToModel> {
  private readonly subscriptions = new BiMap<TTM, true>();

  constructor(readonly typeToModel: TTM) {}

  /**
   * Processes the given changes to the key-value store and our subscriptions.
   * - Updates internal subscriptions.
   * - Returns overall ChangeSet to send to the client, which includes all
   * changes to subscribed values plus blindSets for the newly-subscribed values (if present).
   * It must be sent along with `delta`. (We don't record newly-unsubscribed values as deletes
   * because those are implied by `delta`.)
   *
   * The caller is responsible for rate-limiting calls to this method.
   *
   * @param state The state after the changes, used to send newly-subscribed
   * values to the client.
   */
  processChanges(
    changeSets: ChangeSet<TTM>[],
    delta: SubscriptionDelta<TTM> | null,
    state: GetState<TTM>
  ): ChangeSet<TTM> {
    // Process deleted subscriptions first, so that we skip them in the changeSets.
    if (delta) {
      for (const [type, id] of delta.deletes.entries()) {
        this.subscriptions.delete(type, id);
      }
    }

    // Build up cumulative ChangeSet from changeSets, filtered to existing subscriptions.
    const overallChanges = new ChangeSet(this.typeToModel);
    for (const changeSet of changeSets) {
      overallChanges.apply(
        changeSet,
        (type, id) => !this.subscriptions.has(type, id)
      );
    }

    // Process added subscriptions, also recording their final values as blindSets
    // in the ChangeSet.
    if (delta) {
      for (const [type, id] of delta.adds.entries()) {
        this.subscriptions.set(type, id, true);
        const value = state.get(type, id);
        if (value) overallChanges.blindSets.set(type, id, value);
      }
    }

    return overallChanges;
  }
}
