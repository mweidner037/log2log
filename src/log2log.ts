import { BiMap } from "./bi_map";
import { BaseTypeToModel, BaseValue } from "./model";
import { ValueStore } from "./store";
import { Transaction } from "./transaction";

export class Log2Log<TTM extends BaseTypeToModel> {
  constructor(readonly typeToModel: TTM, readonly store: ValueStore<TTM>) {}
}

interface TransactionUpdates<TTM extends BaseTypeToModel> {
  sets: BiMap<TTM, BaseValue>;
  updates: BiMap<TTM, object[]>;
}

class TransactionImpl<TTM extends BaseTypeToModel> implements Transaction<TTM> {
  constructor(
    private readonly typeToModel: TTM,
    private readonly store: ValueStore<TTM>
  ) {}

  getUpdates(): TransactionUpdates<TTM> {}
}
