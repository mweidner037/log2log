import { BaseTypeToModel } from "../model";

/**
 * Creates a composite key from a type and id.
 */
function makeKey(type: unknown, id: string): string {
  return `${type}\\${id}`;
}

/**
 * Parses a composite key back into its type and id.
 */
function parseKey<T extends string>(compositeKey: string): [T, string] {
  const idx = compositeKey.indexOf("\\");
  return [compositeKey.slice(0, idx) as T, compositeKey.slice(idx + 1)];
}

/**
 * Mutable analog of Map<Type, Map<Id, V>>, keyed by (type, id) pairs.
 *
 * All mutation methods modify this instance in place.
 */
export class BiMap<TTM extends BaseTypeToModel, V> {
  /**
   * Maps `${type}\\${id}` to map value.
   */
  private state = new Map<string, V>();

  /**
   * Returns the number of entries in the map.
   */
  get size(): number {
    return this.state.size;
  }

  /**
   * Gets the value at (type, id), or undefined if not present.
   */
  get(type: keyof TTM, id: string): V | undefined {
    return this.state.get(makeKey(type, id));
  }

  /**
   * Returns true if the map contains an entry at (type, id).
   */
  has(type: keyof TTM, id: string): boolean {
    return this.state.has(makeKey(type, id));
  }

  /**
   * Sets the value at (type, id).
   */
  set(type: keyof TTM, id: string, value: V): void {
    this.state.set(makeKey(type, id), value);
  }

  /**
   * Removes the entry at (type, id).
   * Returns true if an entry was removed, false if it didn't exist.
   */
  delete(type: keyof TTM, id: string): boolean {
    return this.state.delete(makeKey(type, id));
  }

  /**
   * Returns all entries for a given type as an array of [id, value] pairs.
   */
  getInner(type: keyof TTM): Array<[string, V]> {
    const results: Array<[string, V]> = [];
    const prefix = (type as keyof TTM & string) + "\\";
    for (const [compositeKey, value] of this.state) {
      if (compositeKey.startsWith(prefix)) {
        results.push([compositeKey.slice(prefix.length), value]);
      }
    }
    return results;
  }

  /**
   * Returns true if there are any entries for the given type.
   */
  hasInner(type: keyof TTM): boolean {
    const prefix = (type as keyof TTM & string) + "\\";
    for (const compositeKey of this.state.keys()) {
      if (compositeKey.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Removes all entries for the given type.
   */
  deleteInner(type: keyof TTM): void {
    const prefix = (type as keyof TTM & string) + "\\";
    for (const compositeKey of this.state.keys()) {
      if (compositeKey.startsWith(prefix)) {
        this.state.delete(compositeKey);
      }
    }
  }

  /**
   * Iterates over all entries in the map, calling the visitor for each.
   */
  forEach(visitor: (type: keyof TTM, id: string, value: V) => void): void {
    for (const [compositeKey, value] of this.state) {
      const [type, id] = parseKey<keyof TTM & string>(compositeKey);
      visitor(type, id, value);
    }
  }

  /**
   * Returns an iterator over all entries as [type, id, value] tuples.
   */
  *entries(): IterableIterator<[keyof TTM & string, string, V]> {
    for (const [compositeKey, value] of this.state) {
      const [type, id] = parseKey<keyof TTM & string>(compositeKey);
      yield [type, id, value];
    }
  }

  /**
   * Returns an iterator over all values in the map.
   */
  values(): IterableIterator<V> {
    return this.state.values();
  }

  /**
   * Returns all unique type keys.
   */
  outerKeys(): Set<keyof TTM & string> {
    const seen = new Set<keyof TTM & string>();
    for (const compositeKey of this.state.keys()) {
      const [type] = parseKey<keyof TTM & string>(compositeKey);
      seen.add(type);
    }
    return seen;
  }
}
