import { BaseTypeToModel, ValueType } from "./model";

export type SavedState<TTM extends BaseTypeToModel> = {
  [K in keyof TTM]: ValueType<TTM, K>[];
};
