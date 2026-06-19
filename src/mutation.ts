import { BaseTypeToModel } from "./model";
import { Transaction } from "./transaction";

/**
 * Type of a callback that applies a mutation to the key-value store state,
 * using the given Transaction.
 *
 * The callback may throw to fail the mutation, turning it into a no-op.
 */
export type MutationCallback<TTM extends BaseTypeToModel> = (
  transaction: Transaction<TTM>
) => void;
