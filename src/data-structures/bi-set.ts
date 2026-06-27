import { makeKey, parseKey } from "../internal/map-helpers";
import { BaseTypeToModel } from "../types/model";

/**
 * Analog of Set<(type, id)>.
 *
 * All mutation methods modify this instance in place.
 *
 * Type keys are assumed not to contain a colon ("\\").
 */
export class BiSet<TTM extends BaseTypeToModel> {
  /**
   * Set of strings makeKey(type, id).
   */
  private state = new Set<string>();

  /**
   * Returns the number of values in the set.
   */
  get size(): number {
    return this.state.size;
  }

  /**
   * Returns true if the map contains (type, id).
   */
  has(type: keyof TTM, id: string): boolean {
    return this.state.has(makeKey(type, id));
  }

  /**
   * Adds the value (type, id).
   */
  add(type: keyof TTM, id: string): void {
    this.state.add(makeKey(type, id));
  }

  /**
   * Removes the value (type, id).
   * Returns true if a value was removed, false if it didn't exist.
   */
  delete(type: keyof TTM, id: string): boolean {
    return this.state.delete(makeKey(type, id));
  }

  /**
   * Returns all ids for a given type as an array.
   */
  getInner(type: keyof TTM): string[] {
    const results: string[] = [];
    const prefix = (type as keyof TTM & string) + "\\";
    for (const compositeKey of this.state) {
      if (compositeKey.startsWith(prefix)) {
        results.push(compositeKey.slice(prefix.length));
      }
    }
    return results;
  }

  /**
   * Returns an iterator over all values in the map.
   */
  *values(): IterableIterator<[keyof TTM & string, string]> {
    for (const compositeKey of this.state) {
      const [type, id] = parseKey<keyof TTM & string>(compositeKey);
      yield [type, id];
    }
  }

  [Symbol.iterator]() {
    return this.values();
  }

  /**
   * Returns a clone of this BiSet.
   */
  clone(): BiSet<TTM> {
    const ans = new BiSet();
    for (const key of this.state) ans.state.add(key);
    return ans;
  }
}
