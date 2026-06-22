import { BaseTypeToModel, MutableValueType, ValueType } from "./model";

export interface Transaction<TTM extends BaseTypeToModel> {
  /**
   * Returns the value with the given type and id, or undefined if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): ValueType<TTM, K> | undefined;

  /**
   * Returns the values with the given type and ids.
   *
   * The returned values are in the same order as ids, skipping any ids
   * that do not exist.
   */
  getAll<K extends keyof TTM>(type: K, ids: string[]): ValueType<TTM, K>[];

  /**
   * Returns a mutable version of the value with the given type and id,
   * or undefined if it does not exist.
   *
   * Changes to the mutable value are committed at the end of the transaction.
   */
  getMutable<K extends keyof TTM>(
    type: K,
    id: string
  ): MutableValueType<TTM, K> | undefined;
  /**
   * Returns a mutable version of the value with the given type and id,
   * creating it from the given initialValue if it does not exist.
   *
   * Changes to the mutable value are committed at the end of the transaction.
   * If the mutable value is created from initialValue but no further changes are made,
   * the initialValue is committed.
   */
  getMutable<K extends keyof TTM>(
    type: K,
    id: string,
    initialValue: ValueType<TTM, K>
  ): MutableValueType<TTM, K>;

  /**
   * Returns mutable versions of the values with the given type and ids.
   *
   * The returned values are in the same order as ids, skipping any ids
   * that do not exist.
   *
   * Changes to the mutable values are committed at the end of the transaction.
   */
  getAllMutable<K extends keyof TTM>(
    type: K,
    ids: string[]
  ): MutableValueType<TTM, K>[];

  /**
   * Sets the given value, storing it according to its type and id.
   * The value may be new or it may overwrite an existing value.
   *
   * Note: Any active mutable versions of the value are overridden
   * (their changes will not be committed). Future reads and writes to
   * the mutable versions exhibit undefined behavior.
   */
  set<K extends keyof TTM>(value: ValueType<TTM, K>): void;

  /**
   * Deletes the value with the given type and id from the store.
   * Deleting a value that does not exist is a no-op.
   *
   * Note: Any active mutable versions of the value are overridden
   * (their changes will not be committed). Future reads and writes to
   * the mutable versions exhibit undefined behavior.
   */
  delete<K extends keyof TTM>(type: K, id: string): void;
}
