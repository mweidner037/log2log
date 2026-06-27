import * as z from "zod";
import { BaseTypeToModel } from "../types/model";
import { BiSet } from "./bi-set";

export type SavedSubscriptionDelta = {
  /** Adds, mapping type to an array of ids. */
  adds: Record<string, string[]>;
  /** Deletes, mapping type to an array of ids. */
  deletes: Record<string, string[]>;
};

/**
 * Zod schema for SavedSubscriptionDelta.
 */
export const zSubscriptionDelta: z.ZodType<SavedSubscriptionDelta> = z.object({
  adds: z.record(z.string(), z.array(z.string())),
  deletes: z.record(z.string(), z.array(z.string())),
});

export class SubscriptionDelta<TTM extends BaseTypeToModel> {
  constructor(
    readonly adds = new BiSet<TTM>(),
    readonly deletes = new BiSet<TTM>()
  ) {}

  /**
   * Applies another SubscriptionDelta on top of this one, modifying this one in-place.
   */
  apply(delta: SubscriptionDelta<TTM>): void {
    for (const [type, id] of delta.adds) {
      this.add(type, id);
    }
    for (const [type, id] of delta.deletes) {
      this.delete(type, id);
    }
  }

  add<K extends keyof TTM>(type: K, id: string): void {
    this.adds.add(type, id);
    this.deletes.delete(type, id);
  }

  delete<K extends keyof TTM>(type: K, id: string): void {
    this.deletes.add(type, id);
    this.adds.delete(type, id);
  }

  save(): SavedSubscriptionDelta {
    const adds: Record<string, string[]> = {};
    for (const [type, id] of this.adds) {
      const ids = adds[type];
      if (ids === undefined) adds[type] = [id];
      else ids.push(id);
    }

    const deletes: Record<string, string[]> = {};
    for (const [type, id] of this.deletes) {
      const ids = deletes[type];
      if (ids === undefined) deletes[type] = [id];
      else ids.push(id);
    }

    return { adds, deletes };
  }

  static load<TTM extends BaseTypeToModel>(
    json: object
  ): SubscriptionDelta<TTM> {
    const saved = json as SavedSubscriptionDelta;

    const adds = new BiSet();
    for (const type of Object.keys(saved.adds)) {
      for (const id of saved.adds[type]) adds.add(type, id);
    }

    const deletes = new BiSet();
    for (const type of Object.keys(saved.deletes)) {
      for (const id of saved.deletes[type]) deletes.add(type, id);
    }

    return new SubscriptionDelta(adds, deletes);
  }
}
