import { BaseTypeToModel } from "./model";
import { Transaction } from "./transaction";

export interface Mutation<TTM extends BaseTypeToModel> {
  /** A unique ID for this mutation. */
  id: string;
  /**
   * A callback that applies the mutation to the key-value store state,
   * using the given Transaction.
   *
   * The callback may throw to fail the mutation, turning it into a no-op.
   *
   * Note that the callback may be called multiple times on a ReconciliationClient.
   */
  apply: (transaction: Transaction<TTM>) => void;
}
