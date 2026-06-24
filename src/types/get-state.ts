import { BaseTypeToModel, BaseValue } from "./model";

export interface GetState<TTM extends BaseTypeToModel> {
  /**
   * Returns the value with the given type and id, or undefined if it does not exist.
   */
  get<K extends keyof TTM>(type: K, id: string): BaseValue | undefined;
}
