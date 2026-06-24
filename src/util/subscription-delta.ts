import { BaseTypeToModel } from "../model";
import { BiMap } from "./bi-map";

export class SubscriptionDelta<TTM extends BaseTypeToModel> {
  constructor(
    readonly adds: BiMap<TTM, true>,
    readonly deletes: BiMap<TTM, true>
  ) {}

  /**
   * Applies another SubscriptionDelta on top of this one, modifying this one in-place.
   */
  apply(delta: SubscriptionDelta<TTM>): void {
    for (const [type, id] of delta.adds.entries()) {
      this.adds.set(type, id, true);
      this.deletes.delete(type, id);
    }
    for (const [type, id] of delta.deletes.entries()) {
      this.deletes.set(type, id, true);
      this.adds.delete(type, id);
    }
  }
}
