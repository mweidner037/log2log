import { BaseTypeToModel } from "./model";

/**
 * A saved state maps type -> array of serialized values for that type.
 */
export type SavedState<TTM extends BaseTypeToModel> = {
  [K in keyof TTM]: Array<object>;
};
