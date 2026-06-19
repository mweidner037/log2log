import createRBTree from "functional-red-black-tree";
import { BaseTypeToModel } from "../model";

/**
 * Creates a composite key from a type and id.
 */
function makeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Parses a composite key back into its type and id.
 */
function parseKey<T extends string>(compositeKey: string): [T, string] {
  const idx = compositeKey.indexOf(":");
  return [compositeKey.slice(0, idx) as T, compositeKey.slice(idx + 1)];
}

/**
 * Persistent (immutable) analog of {@link BiMap}, i.e., of Map<Type, Map<Id, V>>
 * keyed by (type, id) pairs.
 *
 * All mutation methods return a new instance, leaving the original unchanged.
 * Uses a functional red-black tree internally for efficient persistent
 * operations.
 *
 * Type keys are assumed not to contain a colon (":").
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
  get(type: keyof TTM & string, id: string): V | undefined {
    const result = this.tree.get(makeKey(type, id));
    // The library returns void for missing keys; convert to undefined.
    return result === undefined ? undefined : result;
  }

  /**
   * Returns true if the map contains an entry at (type, id).
   */
  has(type: keyof TTM & string, id: string): boolean {
    return this.tree.find(makeKey(type, id)).valid;
  }

  /**
   * Returns a new map with the value set at (type, id).
   */
  set(type: keyof TTM & string, id: string, value: V): PersistentBiMap<TTM, V> {
    const key = makeKey(type, id);
    // Remove any existing entry first, then insert the new one.
    const inserted = this.tree.remove(key).insert(key, value);
    return new PersistentBiMap(inserted);
  }

  /**
   * Returns a new map with the entry at (type, id) removed.
   * If the entry doesn't exist, returns this map unchanged.
   */
  delete(type: keyof TTM & string, id: string): PersistentBiMap<TTM, V> {
    const key = makeKey(type, id);
    if (!this.tree.find(key).valid) {
      return this;
    }
    return new PersistentBiMap(this.tree.remove(key));
  }

  /**
   * Returns all entries for a given type as an array of [id, value] pairs.
   */
  getInner(type: keyof TTM & string): Array<[string, V]> {
    const results: Array<[string, V]> = [];
    const prefix = type + ":";
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
  hasInner(type: keyof TTM & string): boolean {
    const prefix = type + ":";
    const iter = this.tree.ge(prefix);
    return iter.valid && iter.key !== undefined && iter.key.startsWith(prefix);
  }

  /**
   * Returns a new map with all entries for the given type removed.
   * If there are no such entries, returns this map unchanged.
   */
  deleteInner(type: keyof TTM & string): PersistentBiMap<TTM, V> {
    const prefix = type + ":";
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
