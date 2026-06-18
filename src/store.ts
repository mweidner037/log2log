import { BaseTypeToModel, ValueType } from "./type-to-model";

export interface ValueStore<TypeToModel extends BaseTypeToModel> {
  get<K extends keyof TypeToModel>(
    type: K,
    id: string
  ): ValueType<TypeToModel, K> | null;

  set<K extends keyof TypeToModel>(value: ValueType<TypeToModel, K>): void;
}
