import { ValueStore } from "./store";
import { BaseTypeToModel } from "./type-to-model";

export class Log2Log<TypeToModel extends BaseTypeToModel> {
  constructor(readonly store: ValueStore<TypeToModel>) {}
}
