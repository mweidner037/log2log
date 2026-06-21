import { IdList, SavedIdList } from "articulated";
import { BaseValue, DefModel, MutableValue } from "../model";

export interface IdListValue<K extends string = string> extends BaseValue<K> {
  readonly list: IdList;
}

// TODO
export type IdListUpdate = {};

interface SavedIdListValue {
  type: string;
  id: string;
  list: SavedIdList;
}

export class MutableIdListValue<K extends string = string>
  implements MutableValue<IdListValue<K>, IdListUpdate>
{
  private _list: IdList;

  constructor(readonly type: K, readonly id: string, list: IdList) {
    this._list = list;
  }

  get list(): IdList {
    return this._list;
  }
}

export function defineIdListModel<K extends string>(
  type: K
): DefModel<IdListValue<K>, MutableIdListValue<K>, IdListUpdate> {
  return {
    toMutable: function (value: IdListValue<K>): MutableIdListValue<K> {
      return new MutableIdListValue(value.type, value.id, value.list);
    },
    applyUpdates: function (
      value: IdListValue<K>,
      updates: IdListUpdate[]
    ): IdListValue<K> {
      // TODO
    },
    save: function (value: IdListValue<K>): object {
      return {
        type: value.type,
        id: value.id,
        list: value.list.save(),
      } satisfies SavedIdListValue;
    },
    load: function (json: object): IdListValue<K> {
      const saved = json as SavedIdListValue;
      if (saved.type !== type) {
        throw new Error("Saved state has wrong type: " + saved.type);
      }
      return {
        type,
        id: saved.id,
        list: IdList.load(saved.list),
      };
    },
  };
}
