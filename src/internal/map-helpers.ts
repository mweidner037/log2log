/**
 * Creates a composite key from a type and id.
 */
export function makeKey(type: unknown, id: string): string {
  return `${type}\\${id}`;
}

/**
 * Parses a composite key back into its type and id.
 */
export function parseKey<T extends string>(compositeKey: string): [T, string] {
  const idx = compositeKey.indexOf("\\");
  return [compositeKey.slice(0, idx) as T, compositeKey.slice(idx + 1)];
}
