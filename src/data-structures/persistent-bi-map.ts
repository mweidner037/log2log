import createRBTree from "functional-red-black-tree";
import { makeKey, parseKey } from "../internal/map-helpers";
import { BaseTypeToModel } from "../types/model";

/**
 * Persistent (immutable) analog of Map<(type, id), V>.
 *
 * All mutation methods return a new instance, leaving the original unchanged.
 * Uses a functional red-black tree internally for efficient persistent
 * operations.
 *
 * Type keys are assumed not to contain a colon ("\\").
 */
export class PersistentBiMap<TTM extends BaseTypeToModel, V> {
  private readonly tree: createRBTree.Tree<string, V>;

  private constructor(tree: createRBTree.Tree<string, V>) {
    this.tree = tree;
  }

  /**
   * Creates an empty PersistentBiMap.
   */
  static empty<TTM extends BaseTypeToModel, V>(): PersistentBiMap<TTM, V> {
    return new PersistentBiMap<TTM, V>(createRBTree<string, V>());
  }

  /**
   * Returns the number of entries in the map.
   */
  get size(): number {
    return this.tree.length;
  }

  /**
   * Gets the value at (type, id), or undefined if not present.
   */
  get(type: keyof TTM, id: string): V | undefined {
    const result = this.tree.get(makeKey(type, id));
    // The library returns void for missing keys; convert to undefined.
    return result === undefined ? undefined : result;
  }

  /**
   * Returns true if the map contains an entry at (type, id).
   */
  has(type: keyof TTM, id: string): boolean {
    return this.tree.find(makeKey(type, id)).valid;
  }

  /**
   * Returns a new map with the value set at (type, id).
   */
  set(type: keyof TTM, id: string, value: V): PersistentBiMap<TTM, V> {
    const key = makeKey(type, id);
    // Remove any existing entry first, then insert the new one.
    const inserted = this.tree.remove(key).insert(key, value);
    return new PersistentBiMap(inserted);
  }

  /**
   * Returns a new map with the entry at (type, id) removed.
   * If the entry doesn't exist, returns this map unchanged.
   */
  delete(type: keyof TTM, id: string): PersistentBiMap<TTM, V> {
    const key = makeKey(type, id);
    if (!this.tree.find(key).valid) {
      return this;
    }
    return new PersistentBiMap(this.tree.remove(key));
  }

  /**
   * Returns all entries for a given type as an array of [id, value] pairs.
   */
  getInner(type: keyof TTM): Array<[string, V]> {
    const results: Array<[string, V]> = [];
    const prefix = (type as keyof TTM & string) + "\\";
    // Find the first key >= prefix, then walk while the prefix matches.
    const iter = this.tree.ge(prefix);
    while (iter.valid) {
      const compositeKey = iter.key;
      if (compositeKey === undefined || !compositeKey.startsWith(prefix)) {
        break;
      }
      results.push([compositeKey.slice(prefix.length), iter.value as V]);
      iter.next();
    }
    return results;
  }

  /**
   * Returns true if there are any entries for the given type.
   */
  hasInner(type: keyof TTM): boolean {
    const prefix = (type as keyof TTM & string) + "\\";
    const iter = this.tree.ge(prefix);
    return iter.valid && iter.key !== undefined && iter.key.startsWith(prefix);
  }

  /**
   * Returns a new map with all entries for the given type removed.
   * If there are no such entries, returns this map unchanged.
   */
  deleteInner(type: keyof TTM): PersistentBiMap<TTM, V> {
    const prefix = (type as keyof TTM & string) + "\\";
    const keysToRemove: string[] = [];

    // Collect all keys with the given prefix.
    const iter = this.tree.ge(prefix);
    while (iter.valid) {
      const compositeKey = iter.key;
      if (compositeKey === undefined || !compositeKey.startsWith(prefix)) {
        break;
      }
      keysToRemove.push(compositeKey);
      iter.next();
    }

    if (keysToRemove.length === 0) {
      return this;
    }

    let tree = this.tree;
    for (const key of keysToRemove) {
      tree = tree.remove(key);
    }
    return new PersistentBiMap(tree);
  }

  /**
   * Iterates over all entries in the map, calling the visitor for each.
   * Iteration order is lexicographic by (type, id).
   */
  forEach(
    visitor: (type: keyof TTM & string, id: string, value: V) => void
  ): void {
    this.tree.forEach((compositeKey, value) => {
      const [type, id] = parseKey<keyof TTM & string>(compositeKey);
      visitor(type, id, value);
    });
  }

  /**
   * Returns an iterator over all entries as [type, id, value] tuples.
   * Iteration order is lexicographic by (type, id).
   */
  *entries(): IterableIterator<[keyof TTM & string, string, V]> {
    const iter = this.tree.begin;
    while (iter.valid) {
      const [type, id] = parseKey<keyof TTM & string>(iter.key as string);
      yield [type, id, iter.value as V];
      iter.next();
    }
  }

  /**
   * Returns an iterator over all values in the map.
   * Iteration order is lexicographic by (type, id).
   */
  *values(): IterableIterator<V> {
    const iter = this.tree.begin;
    while (iter.valid) {
      yield iter.value as V;
      iter.next();
    }
  }

  /**
   * Returns all unique type keys.
   */
  outerKeys(): Set<keyof TTM & string> {
    const seen = new Set<keyof TTM & string>();
    this.tree.forEach((compositeKey) => {
      const [type] = parseKey<keyof TTM & string>(compositeKey);
      seen.add(type);
    });
    return seen;
  }
}
