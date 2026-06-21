import { ElementId, IdList, SavedIdList } from "articulated";
import { BaseValue, DefModel, MutableValue } from "../model";

export interface IdListValue<K extends string = string> extends BaseValue<K> {
  readonly list: IdList;
}

/**
 * A single change to an {@link IdList}, mirroring its mutating methods
 * (insertAfter, insertBefore, uninsert, delete, deleteRange, undelete).
 *
 * The `op` field discriminates the union. Each variant's remaining fields are
 * the corresponding method's arguments; an omitted `count` means the method's
 * default (a single id).
 */
export type IdListUpdate =
  | {
      readonly op: "insertAfter";
      readonly before: ElementId | null;
      readonly newId: ElementId;
      readonly count?: number;
    }
  | {
      readonly op: "insertBefore";
      readonly after: ElementId | null;
      readonly newId: ElementId;
      readonly count?: number;
    }
  | { readonly op: "uninsert"; readonly id: ElementId; readonly count?: number }
  | { readonly op: "delete"; readonly id: ElementId; readonly count?: number }
  | { readonly op: "undelete"; readonly id: ElementId; readonly count?: number }
  | { readonly op: "deleteRange"; readonly from: number; readonly to: number };

/** Applies a single {@link IdListUpdate} to `list`, returning the new IdList. */
function applyIdListUpdate(list: IdList, update: IdListUpdate): IdList {
  switch (update.op) {
    case "insertAfter":
      return list.insertAfter(update.before, update.newId, update.count);
    case "insertBefore":
      return list.insertBefore(update.after, update.newId, update.count);
    case "uninsert":
      return list.uninsert(update.id, update.count);
    case "delete":
      return list.delete(update.id, update.count);
    case "undelete":
      return list.undelete(update.id, update.count);
    case "deleteRange":
      return list.deleteRange(update.from, update.to);
  }
}

interface SavedIdListValue {
  type: string;
  id: string;
  list: SavedIdList;
}

/**
 * Mutable wrapper around an {@link IdListValue}. Its mutating methods mirror
 * those of {@link IdList}; each one advances the wrapped (persistent) list and
 * records a corresponding {@link IdListUpdate}.
 */
export class MutableIdListValue<K extends string = string>
  implements MutableValue<IdListValue<K>, IdListUpdate>
{
  private _list: IdList;
  private readonly updates: IdListUpdate[] = [];

  constructor(readonly type: K, readonly id: string, list: IdList) {
    this._list = list;
  }

  get list(): IdList {
    return this._list;
  }

  /** Applies `update` to the wrapped list and records it. */
  private apply(update: IdListUpdate): void {
    this._list = applyIdListUpdate(this._list, update);
    this.updates.push(update);
  }

  insertAfter(
    before: ElementId | null,
    newId: ElementId,
    count?: number
  ): void {
    this.apply(
      count === undefined
        ? { op: "insertAfter", before, newId }
        : { op: "insertAfter", before, newId, count }
    );
  }

  insertBefore(
    after: ElementId | null,
    newId: ElementId,
    count?: number
  ): void {
    this.apply(
      count === undefined
        ? { op: "insertBefore", after, newId }
        : { op: "insertBefore", after, newId, count }
    );
  }

  uninsert(id: ElementId, count?: number): void {
    this.apply(
      count === undefined
        ? { op: "uninsert", id }
        : { op: "uninsert", id, count }
    );
  }

  delete(id: ElementId, count?: number): void {
    this.apply(
      count === undefined ? { op: "delete", id } : { op: "delete", id, count }
    );
  }

  undelete(id: ElementId, count?: number): void {
    this.apply(
      count === undefined
        ? { op: "undelete", id }
        : { op: "undelete", id, count }
    );
  }

  deleteRange(from: number, to: number): void {
    this.apply({ op: "deleteRange", from, to });
  }

  __finish(): { value: IdListValue<K>; updates: IdListUpdate[] } {
    return { value: this.__toImmutable(), updates: this.updates };
  }

  __toImmutable(): IdListValue<K> {
    return { type: this.type, id: this.id, list: this._list };
  }
}

/**
 * Defines a model of the given type whose values are IdListValue / MutableIdListValue.
 *
 * This model wraps an [articulated](https://github.com/mweidner037/articulated) IdList,
 * supporting efficient updates.
 * Use it to work with lists of elements that "shift" in response to changes,
 * like text characters.
 *
 * An IdListValue only stores the ElementIds themselves. You need to store the list elements
 * separately, either as their own key-value store entries or in
 * a collection mapping id -> element.
 * (You may find it convenient to key by your own ids instead of literal ElementIds,
 * storing the ElementIds as a separate "position" field on the elements -
 * e.g., to allow move operations.)
 * Use sortByListId at render time to combine the IdList with those separate elements.
 */
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
      let list = value.list;
      for (const update of updates) {
        list = applyIdListUpdate(list, update);
      }
      return { ...value, list };
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

// TODO: Move to articulated?
/**
 * Given an IdList and an iterable of list elements that are labeled by its ids,
 * returns an array of the list elements in id order.
 */
export function sortByIdList<T>(
  list: IdList,
  elements: Iterable<T>,
  getElementId: (element: T) => ElementId
): T[] {
  // We use two passes to let this run in ~linear time instead of quadratic.

  // 1. Make a map ElementId -> element.
  const elementsById = new Map<string, T>();
  for (const element of elements) {
    const id = getElementId(element);
    elementsById.set(elementIdToString(id), element);
  }

  // 2. Iterate through list, mapping each id to its element.
  const ans: T[] = [];
  for (const id of list) {
    const idStr = elementIdToString(id);
    if (elementsById.has(idStr)) {
      ans.push(elementsById.get(idStr)!);
    }
  }

  return ans;
}

function elementIdToString(id: ElementId): string {
  // ":" is okay here because it will never appear in a counter string.
  return `${id.bunchId}:${id.counter}`;
}
