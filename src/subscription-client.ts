import { BaseTypeToModel } from "./model";
import { ReconciliationReplica } from "./reconciliation-replica";
import { BiMap } from "./util/bi-map";

// TODO: Reactivity for isKnown changes from either cause
// TODO: Rerun local mutations when we receive subscription updates?
// TODO: Does unsubscribing immediately drop a value, or do we wait for the
// server's response? If the former, do we rerun local mutations?

export class SubscriptionClient<TTM extends BaseTypeToModel> {
  private readonly activeSubscriptions = new BiMap<TTM, true>();
  private readonly requestedSubscriptions = new BiMap<TTM, true>();

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
}
