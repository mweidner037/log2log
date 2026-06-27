import { BiSet } from "./data-structures/bi-set";
import { SubscriptionDelta } from "./data-structures/subscription-delta";
import { ReconciliationReplica } from "./reconciliation-replica";
import { BaseTypeToModel } from "./types/model";

/**
 * Holds a client's set of subscriptions.
 *
 * A value is **known** to the client if we have an **active** subscription
 * (i.e., it is being actively updated from the server)
 * *or* it has been changed optimistically.
 * Both scenarios include the case that the value has been deleted.
 *
 * (Un)subscriptions must first be **requested**; they become active only once
 * you send the corresponding delta (from calling getAndResetDelta afterwards)
 * and get a response from the SubscriptionServer that acks the request.
 * Until a subscription is active, its value does not receive updates from the
 * SubscriptionServer, and its server value is not present in the ReconciliationReplica.
 *
 * See the Subscriptions section in ReconciliationReplica's class docs for usage instructions.
 */
export class SubscriptionClient<TTM extends BaseTypeToModel> {
  private readonly activeSubscriptions = new BiSet<TTM>();
  private readonly requestedSubscriptions = new BiSet<TTM>();

  private pendingDelta = new SubscriptionDelta<TTM>();

  /**
   * @param replica The ReconciliationReplica holding the client's state.
   * This state is only read, as part of computing isKnown.
   * Writes driven by subscription changes happen in ReconciliationReplica.applyServerChanges.
   */
  constructor(
    readonly typeToModel: TTM,
    readonly replica: ReconciliationReplica<TTM>
  ) {}

  /**
   * Returns whether we have an active subscription for a value.
   */
  isActive<K extends keyof TTM>(type: K, id: string): boolean {
    return this.activeSubscriptions.has(type, id);
  }

  /**
   * Returns whether we have a requested subscription for a value.
   */
  isRequested<K extends keyof TTM>(type: K, id: string): boolean {
    return this.requestedSubscriptions.has(type, id);
  }

  /**
   * Returns whether a value is known to the client, as defined in our class docs.
   */
  isKnown<K extends keyof TTM>(type: K, id: string): boolean {
    // A value is known if its subscription is active or it has been edited optimistically
    // (including optimistic deletes, even when applied to non-subscribed values).
    if (this.isActive(type, id)) return true;
    if (this.replica.optimisticDiff.sets.has(type, id)) return true;
    if (this.replica.optimisticDiff.deletes.has(type, id)) return true;
    return false;
  }

  /**
   * Creates a requested subscription to the given value.
   */
  subscribe<K extends keyof TTM>(type: K, id: string): void {
    if (!this.requestedSubscriptions.has(type, id)) {
      this.pendingDelta.add(type, id);
      this.requestedSubscriptions.add(type, id);
    }
  }

  /**
   * Creates a requested unsubscription for the given value.
   */
  unsubscribe<K extends keyof TTM>(type: K, id: string): void {
    if (this.requestedSubscriptions.has(type, id)) {
      this.pendingDelta.delete(type, id);
      this.requestedSubscriptions.delete(type, id);
    }
  }

  /**
   * Returns the SubscriptionDelta corresponding to all (un)subcription requests
   * since the last time this method was called.
   */
  getAndResetDelta(): SubscriptionDelta<TTM> {
    const ans = this.pendingDelta;
    this.pendingDelta = new SubscriptionDelta();
    return ans;
  }

  /**
   * Returns the (add-only) SubscriptionDelta corresponding to all of our requested subscriptions.
   *
   * Use this when re-connecting to a SubscriptionServer.
   */
  getRequests(): SubscriptionDelta<TTM> {
    return new SubscriptionDelta(this.requestedSubscriptions.clone());
  }
}
