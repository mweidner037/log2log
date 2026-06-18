import { BaseTypeToModel, MutableValueType, ValueType } from "./type-to-model";

export interface Transaction<TypeToModel extends BaseTypeToModel> {
  get<K extends keyof TypeToModel>(
    type: K,
    id: string
  ): ValueType<TypeToModel, K> | null;

  getAll<K extends keyof TypeToModel>(
    type: K,
    ids: string[]
  ): ValueType<TypeToModel, K>[];

  getMutable<K extends keyof TypeToModel>(
    type: K,
    id: string
  ): MutableValueType<TypeToModel, K> | null;
  getMutable<K extends keyof TypeToModel>(
    type: K,
    id: string,
    initialValue: ValueType<TypeToModel, K>
  ): MutableValueType<TypeToModel, K>;

  getAllMutable<K extends keyof TypeToModel>(
    type: K,
    ids: string[]
  ): MutableValueType<TypeToModel, K>[];

  set<K extends keyof TypeToModel>(value: ValueType<TypeToModel, K>): void;

  delete<K extends keyof TypeToModel>(type: K, id: string): void;
}
