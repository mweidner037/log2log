export interface BaseValue<K = string> {
  readonly type: K;
  readonly id: string;
}

export interface MutableValue<V, U> {
  beginTransaction(): void;
  rollback(): void;
  commit(): U[];
  toImmutable(): V;
}

export interface DefModel<
  V extends BaseValue,
  U extends object,
  M extends MutableValue<V, U>
> {
  toMutable(value: V): M;
  applyUpdates(value: V, updates: U[]): V;
}

export function defineModel<
  V extends BaseValue,
  U extends object,
  M extends MutableValue<V, U>
>(model: {
  toMutable(value: V): M;
  applyUpdates(value: V, updates: U[]): V;
}): DefModel<V, U, M> {
  return model;
}
