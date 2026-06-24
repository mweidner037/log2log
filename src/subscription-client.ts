import { BaseTypeToModel } from "./model";
import { ReconciliationReplica } from "./reconciliation-replica";
import { BiMap } from "./util/bi-map";
import { SubscriptionDelta } from "./util/subscription-delta";

// TODO: Reactivity for isKnown changes from either cause
// TODO: Rerun local mutations when we receive subscription updates.
// But on the server, wait to send sub deletes until you have a real change.

export class SubscriptionClient<TTM extends BaseTypeToModel> {
  private readonly activeSubscriptions = new BiMap<TTM, true>();
  private readonly requestedSubscriptions = new BiMap<TTM, true>();

  private pendingDelta = new SubscriptionDelta<TTM>();

  constructor(
    readonly typeToModel: TTM,
    readonly replica: ReconciliationReplica<TTM>
  ) {}

  isKnown<K extends keyof TTM>(type: K, id: string): boolean {
    // A value is known if its subscription is active or it has been edited optimistically.
    if (this.activeSubscriptions.has(type, id)) return true;
    if (this.replica.optimisticDiff.sets.has(type, id)) return true;
    if (this.replica.optimisticDiff.deletes.has(type, id)) return true;
    return false;
  }

  subscribe<K extends keyof TTM>(type: K, id: string): void {
    if (!this.requestedSubscriptions.has(type, id)) {
      this.pendingDelta.add(type, id);
      this.requestedSubscriptions.set(type, id, true);
    }
  }

  unsubscribe<K extends keyof TTM>(type: K, id: string): void {
    if (this.requestedSubscriptions.has(type, id)) {
      this.pendingDelta.delete(type, id);
      this.requestedSubscriptions.delete(type, id);
    }
  }

  /**
   * Returns the current built-up SubscriptionDelta and resets it.
   */
  getAndResetDelta(): SubscriptionDelta<TTM> {
    const ans = this.pendingDelta;
    this.pendingDelta = new SubscriptionDelta();
    return ans;
  }
}
