/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseValue, DefModel, MutableModel } from "./model";

export type BaseTypeToModel = {
  [K in string]: DefModel<
    BaseValue<K>,
    object,
    MutableModel<BaseValue<K>, object>
  >;
};

export type ValueType<
  TypeToModel extends BaseTypeToModel,
  K extends keyof TypeToModel
> = TypeToModel[K] extends DefModel<infer V, any, any> ? V : never;

export interface ValueStore<TypeToModel extends BaseTypeToModel> {
  get<K extends keyof TypeToModel>(
    type: K,
    id: string
  ): ValueType<TypeToModel, K> | null;

  set<K extends keyof TypeToModel>(value: ValueType<TypeToModel, K>): void;
}

export class Log2Log<TypeToModel extends BaseTypeToModel> {
  constructor(readonly store: ValueStore<TypeToModel>) {}
}
