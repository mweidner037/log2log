import { TransactionImpl } from "./internal/transaction-impl";
import { BaseTypeToModel, BaseValue } from "./model";
import { Mutation } from "./mutation";
import { SavedState } from "./saved-state";
import { BiMap } from "./util/bi-map";
import { ChangeSet } from "./util/change-set";
import { RenderedChangeSet } from "./util/rendered-change-set";

export type ApplyMutationResult<TTM extends BaseTypeToModel> =
  | {
      isSuccess: true;
      changes: ChangeSet<TTM>;
    }
  | { isSuccess: false; error: unknown };

/**
 * The result of {@link Log2Log.applyMutations}: the per-mutation results plus
 * the final value of every changed (set or updated) key, accumulated across all
 * mutations.
 */
export interface ServerMutationsResult<TTM extends BaseTypeToModel> {
  results: ApplyMutationResult<TTM>[];
  /**
   * The overall changes across all mutations, rendered as final values. Since a
   * {@link ChangeSet}'s updates record only their update objects, this is how to
   * recover updated keys' resulting values.
   */
  rendered: RenderedChangeSet<TTM>;
}

/**
 * Converts a log of mutations into a log of key-value store changes.
 *
 * In the language of [this article](https://mattweidner.com/2024/06/04/server-architectures.html), Log2Log is designed to help implement a collaboration system that sends _mutations_ (high-level operations, like event sourcing events) from client->server but _state changes_ (low-level operations, like SQL row updates) from server->client.
 *
 * The Log2Log class manages a synchronous in-memory key-value store,
 * accepts mutations to that store (via applyMutations), and changes the store
 * while returning the corresponding ChangeSet.
 * It is designed for use on a central collaboration server.
 */
export class Log2Log<TTM extends BaseTypeToModel> {
  private readonly state = new BiMap<TTM, BaseValue>();

  constructor(
    readonly typeToModel: TTM,
    readonly initialState: SavedState<TTM>
  ) {
    // Load the initial state so that mutations can read existing values.
    for (const type of Object.keys(typeToModel) as (keyof TTM & string)[]) {
      const model = typeToModel[type];
      const savedValues = initialState[type];
      if (savedValues === undefined) continue;
      for (const savedValue of savedValues) {
        const value = model.load(savedValue);
        this.state.set(type, value.id, value);
      }
    }
  }

  /**
   * Applies a sequence of mutations, returning their success/failure statuses
   * and the overall changes.
   *
   * Any mutations that throw become no-ops.
   */
  applyMutations(mutations: Mutation<TTM>[]): ServerMutationsResult<TTM> {
    const results: ApplyMutationResult<TTM>[] = [];
    // The overall changes across all mutations, as final values and deletions.
    const rendered = new RenderedChangeSet<TTM>(this.typeToModel);

    for (const mutation of mutations) {
      const transaction = new TransactionImpl(this.typeToModel, this.state);
      try {
        mutation.apply(transaction);
      } catch (error) {
        // A failed mutation is a no-op: record the error and move on without
        // touching the state.
        console.log("Mutation " + mutation.id + " failed, skipping", error);
        results.push({ isSuccess: false, error });
        continue;
      }

      // The mutation succeeded. Apply its changes to this.state so that the
      // next mutation sees them, recording each key's change in `rendered`, and
      // report the changes as this mutation's result. The transaction's allSets
      // already holds each changed key's final value (blind-set or updated), so
      // apply those directly instead of replaying updates. recordSet/recordDelete
      // keep `rendered` consistent: a later set un-deletes a key and vice versa.
      const { changes, allSets: changedValues } = transaction.getChanges();
      for (const [type, id, value] of changedValues.entries()) {
        this.state.set(type, id, value);
        rendered.recordSet(type, id, value);
      }
      for (const [type, id] of changes.deletes.entries()) {
        this.state.delete(type, id);
        rendered.recordDelete(type, id);
      }

      results.push({ isSuccess: true, changes });
    }

    return { results, rendered };
  }

  /**
   * Returns the current state as a {@link SavedState}, with one array of values
   * per type (empty for types that have no values).
   */
  save(): SavedState<TTM> {
    const result = {} as SavedState<TTM>;
    for (const type of Object.keys(this.typeToModel) as (keyof TTM &
      string)[]) {
      const model = this.typeToModel[type];
      result[type] = this.state
        .getInner(type)
        .map(([, value]) => model.save(value)) as SavedState<TTM>[keyof TTM &
        string];
    }
    return result;
  }
}
