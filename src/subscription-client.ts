import { BiSet } from "./data-structures/bi-set";
import { SubscriptionDelta } from "./data-structures/subscription-delta";
import { ReconciliationReplica } from "./reconciliation-replica";
import { BaseTypeToModel } from "./types/model";

export class SubscriptionClient<TTM extends BaseTypeToModel> {
  private readonly activeSubscriptions = new BiSet<TTM>();
  private readonly requestedSubscriptions = new BiSet<TTM>();

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
      this.requestedSubscriptions.add(type, id);
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
