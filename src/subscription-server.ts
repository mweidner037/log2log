import { BiSet } from "./data-structures/bi-set";
import { ChangeSet } from "./data-structures/change-set";
import { SubscriptionDelta } from "./data-structures/subscription-delta";
import { GetState } from "./types/get-state";
import { BaseTypeToModel } from "./types/model";

/**
 * Server that handles requests from a SubscriptionClient and sends it filtered ChangeSets.
 *
 * Use this to partially replicate a Log2Log's changes to a client ReconciliationReplica.
 * You pass ChangeSets from the Log2Log through this.processChanges,
 * which returns a filtered ChangeSet holding only the changes relevant to that client,
 * according to its active subscriptions.
 * See the class docs for ReconciliationReplica.
 */
export class SubscriptionServer<TTM extends BaseTypeToModel> {
  private readonly subscriptions = new BiSet<TTM>();

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
    subscriptionDelta: SubscriptionDelta<TTM> | null,
    state: GetState<TTM>
  ): ChangeSet<TTM> {
    // Process deleted subscriptions first, so that we skip them in the changeSets.
    if (subscriptionDelta) {
      for (const [type, id] of subscriptionDelta.deletes) {
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
    if (subscriptionDelta) {
      for (const [type, id] of subscriptionDelta.adds) {
        this.subscriptions.add(type, id);
        const value = state.get(type, id);
        if (value) overallChanges.blindSets.set(type, id, value);
      }
    }

    return overallChanges;
  }
}
