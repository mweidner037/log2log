export interface BaseValue<K = string> {
  readonly type: K;
  readonly id: string;
}

export interface MutableModel<V, U> {
  beginTransaction(): void;
  rollback(): void;
  commit(): U[];
  toImmutable(): V;
}

export interface DefModel<
  V extends BaseValue,
  U extends object,
  M extends MutableModel<V, U>
> {
  toMutable(value: V): M;
  applyUpdates(value: V, updates: U[]): V;
  compactUpdates(updates: U[]): U[];
}
