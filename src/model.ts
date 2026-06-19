/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BaseValue<K = string> {
  readonly type: K;
  readonly id: string;
}

export interface MutableValue<V, U> {
  beginTransaction(): void;
  commit(): U[];
  toImmutable(): V;
}

export interface DefModel<
  V extends BaseValue,
  M extends MutableValue<V, U>,
  U extends object
> {
  toMutable(value: V): M;
  applyUpdates(value: V, updates: U[]): V;
}

/**
 * Defines a **model**, which is a spec for values of a given type.
 *
 * A model consists of:
 * - A type for (immutable) values (V). Each value must have the model type
 * and a string id as properties.
 * - A type for mutable values (M). A mutable value is a mutable wrapper around
 * an immutable value, with methods to track changes to that value.
 * - A type for updates (U), which describe tracked changes in JSON form.
 * Must be plain objects.
 *
 * Define models using this function, instead of constructing a DefModel directly, for better type inference.
 * Store all of them in an object typeToModel that maps each type name
 * to its defined model.
 */
export function defineModel<
  V extends BaseValue,
  M extends MutableValue<V, U>,
  U extends object
>(model: {
  toMutable(value: V): M;
  applyUpdates(value: V, updates: U[]): V;
}): DefModel<V, M, U> {
  return model;
}

/**
 * Base type for the typeToModel object that every use must have.
 *
 * The typeToModel object must map each type name to its model definition,
 * output by defineModel.
 * Ensure that each type name matches the `type` field in its values.
 *
 * For technical reasons, the type name must **not** contain ":".
 */
export type BaseTypeToModel = {
  [K in string]: DefModel<
    BaseValue<K>,
    MutableValue<BaseValue<K>, object>,
    object
  >;
};

/**
 * Extracts the (immutable) value type from `typeof typeToModel` and the type name.
 */
export type ValueType<
  TTM extends BaseTypeToModel,
  K extends keyof TTM
> = TTM[K] extends DefModel<infer V, any, any> ? V : never;

/**
 * Extracts the mutable value type from `typeof typeToModel` and the type name.
 */
export type MutableValueType<
  TTM extends BaseTypeToModel,
  K extends keyof TTM
> = TTM[K] extends DefModel<any, infer M, any> ? M : never;
