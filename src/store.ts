import { BaseTypeToModel, ValueType } from "./model";

export interface ValueStore<TTM extends BaseTypeToModel> {
  /**
   * Returns the value with the given type and id, or null if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | null;

  /**
   * Returns the values with the given type and ids.
   *
   * The returned values are in the same order as ids, skipping any ids
   * that do not exist.
   */
  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[];

  /**
   * Sets the given value, storing it according to its type and id.
   * The value may be new or it may overwrite an existing value.
   */
  set<K extends keyof TTM>(value: ValueType<TTM, K>): void;
}
