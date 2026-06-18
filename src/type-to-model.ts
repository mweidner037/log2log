/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseValue, DefModel, MutableValue } from "./model";

export type BaseTypeToModel = {
  [K in string]: DefModel<
    BaseValue<K>,
    object,
    MutableValue<BaseValue<K>, object>
  >;
};

export type ValueType<
  TypeToModel extends BaseTypeToModel,
  K extends keyof TypeToModel
> = TypeToModel[K] extends DefModel<infer V, any, any> ? V : never;

export type MutableValueType<
  TypeToModel extends BaseTypeToModel,
  K extends keyof TypeToModel
> = TypeToModel[K] extends DefModel<any, any, infer M> ? M : never;
