import { BaseValue, DefModel, MutableValue, defineModel } from "../model";

/* -------------------------------------------------------------------------- */
/* JSON values.                                                               */
/* -------------------------------------------------------------------------- */

/** A JSON-serializable value, used in JsonPatchExtended. */
export type JsonPatchValue =
  | null
  | boolean
  | number
  | string
  | JsonPatchValue[]
  | { [key: string]: JsonPatchValue };

/** A JSON object (the non-array, non-primitive case of {@link JsonPatchValue}). */
type JsonObject = { [key: string]: JsonPatchValue };
/** A JSON array. */
type JsonArray = JsonPatchValue[];
/** A JSON value that other values can nest inside: an object or array. */
type JsonContainer = JsonObject | JsonArray;

function isContainer(value: JsonPatchValue): value is JsonContainer {
  return typeof value === "object" && value !== null;
}

/* -------------------------------------------------------------------------- */
/* JSON patches (the update type).                                            */
/* -------------------------------------------------------------------------- */

/**
 * A single change to a JSON value, using JSON Patch format (RFC 6902)
 * extended with a "splice" operation for bulk Array adds/removes.
 *
 * Each `path` is a JSON Pointer (RFC 6901): "" for the root, or "/" followed by
 * "/"-separated, escaped path segments (e.g. "/items/0/name").
 */
export type JsonPatchExtended =
  | {
      readonly op: "add";
      readonly path: string;
      readonly value: JsonPatchValue;
    }
  | {
      readonly op: "replace";
      readonly path: string;
      readonly value: JsonPatchValue;
    }
  | { readonly op: "remove"; readonly path: string }
  | {
      /** Replaces `remove` elements starting at `index` with `add`. */
      readonly op: "splice";
      readonly path: string;
      readonly index: number;
      readonly remove: number;
      readonly add: readonly JsonPatchValue[];
    };

/** Escapes a path segment for use in a JSON Pointer. */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Reverses {@link escapeSegment}. */
function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Appends a segment to a JSON Pointer. */
function appendPointer(base: string, segment: string | number): string {
  return base + "/" + escapeSegment(String(segment));
}

/** Splits a JSON Pointer into its (unescaped) path segments. */
function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map(unescapeSegment);
}

/* -------------------------------------------------------------------------- */
/* Proxy-based change tracking.                                               */
/* -------------------------------------------------------------------------- */

/**
 * Tracks all mutations made to a single root JSON value (via its proxies) as a
 * list of {@link JsonPatchExtended}es.
 *
 * The mutations are applied in place to a private deep clone of the root, so
 * the tracker always holds the value's current state. Paths are recomputed
 * lazily (see {@link pointerOf}) so that they stay correct even after array
 * reorderings.
 */
class JsonTracker {
  readonly patches: JsonPatchExtended[] = [];
  /** Cache of proxies, keyed by their backing (live) JSON container. */
  private readonly proxyCache = new WeakMap<JsonContainer, object>();
  /** Maps each non-root container to its parent container and key within it. */
  private readonly parentMap = new WeakMap<JsonContainer, ParentLink>();

  constructor(readonly root: JsonObject) {}

  /**
   * Returns the (cached) proxy for `target`, recording the `parent` and `key`
   * under which it lives so that {@link pointerOf} can find it again. For an
   * object parent `key` is a property name; for an array parent it is the index
   * at access time (a hint that may go stale after reorderings).
   */
  proxyFor(
    target: JsonContainer,
    parent: JsonContainer | null,
    key: string | number
  ): object {
    let proxy = this.proxyCache.get(target);
    if (proxy === undefined) {
      if (parent !== null) this.parentMap.set(target, { parent, key });
      proxy = Array.isArray(target)
        ? new Proxy(target, new ArrayHandler(this, target))
        : new Proxy(target, new ObjectHandler(this, target));
      this.proxyCache.set(target, proxy);
    }
    return proxy;
  }

  /** Returns the existing proxy for `target`, which must already exist. */
  existingProxy(target: JsonContainer): object {
    return this.proxyCache.get(target)!;
  }

  /** Returns the current JSON Pointer to `target` from the root. */
  pointerOf(target: JsonContainer): string {
    if (target === this.root) return "";
    const segmentsRev: string[] = [];
    let current: JsonContainer = target;
    while (current !== this.root) {
      const link = this.parentMap.get(current);
      if (link === undefined) break;
      const { parent } = link;
      if (Array.isArray(parent) && parent[link.key as number] !== current) {
        // The cached index went stale (e.g. after a splice or sort). Repair it;
        // the lookup is then O(1) again until the next reordering.
        link.key = parent.indexOf(current);
      }
      segmentsRev.push(String(link.key));
      current = parent;
    }
    return "/" + segmentsRev.reverse().map(escapeSegment).join("/");
  }
}

/** A non-root container's location: its parent and the key it lives under. */
interface ParentLink {
  readonly parent: JsonContainer;
  /** A property name (object parent) or array index hint (array parent). */
  key: string | number;
}

/** Parses an array index, or returns undefined if `key` is not one. */
function toIndex(key: string): number | undefined {
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && String(n) === key) return n;
  return undefined;
}

/**
 * The {@link MutableValue} methods, exposed on the root proxy. These names are
 * intercepted by {@link ObjectHandler} on the root only; a root JSON object
 * with conflicting property names would shadow them.
 */
const FINISH = "_finish";
const TO_IMMUTABLE = "_toImmutable";

class ObjectHandler implements ProxyHandler<JsonObject> {
  constructor(
    private readonly tracker: JsonTracker,
    private readonly target: JsonObject
  ) {}

  private base(): string {
    return this.tracker.pointerOf(this.target);
  }

  get(target: JsonObject, key: string | symbol): unknown {
    if (typeof key !== "symbol" && target === this.tracker.root) {
      if (key === FINISH) return finishFn(this.tracker);
      if (key === TO_IMMUTABLE) return toImmutableFn(this.tracker);
    }
    if (
      typeof key === "symbol" ||
      !Object.prototype.hasOwnProperty.call(target, key)
    ) {
      return Reflect.get(target, key) as unknown;
    }
    const value = target[key];
    if (isContainer(value)) return this.tracker.proxyFor(value, target, key);
    return value;
  }

  set(target: JsonObject, key: string | symbol, value: unknown): boolean {
    if (typeof key === "symbol") return Reflect.set(target, key, value);
    const existed = Object.prototype.hasOwnProperty.call(target, key);
    const stored = structuredClone(value as JsonPatchValue);
    target[key] = stored;
    this.tracker.patches.push({
      op: existed ? "replace" : "add",
      path: appendPointer(this.base(), key),
      value: structuredClone(stored),
    });
    return true;
  }

  deleteProperty(target: JsonObject, key: string | symbol): boolean {
    if (typeof key === "symbol") return Reflect.deleteProperty(target, key);
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      delete target[key];
      this.tracker.patches.push({
        op: "remove",
        path: appendPointer(this.base(), key),
      });
    }
    return true;
  }
}

class ArrayHandler implements ProxyHandler<JsonArray> {
  constructor(
    private readonly tracker: JsonTracker,
    private readonly target: JsonArray
  ) {}

  private base(): string {
    return this.tracker.pointerOf(this.target);
  }

  private self(): object {
    return this.tracker.existingProxy(this.target);
  }

  /** Emits a patch replacing the whole array (for reorders, fills, etc.). */
  private emitReplaceWhole(): void {
    this.tracker.patches.push({
      op: "replace",
      path: this.base(),
      value: structuredClone(this.target),
    });
  }

  private readonly push = (...items: JsonPatchValue[]): number => {
    const index = this.target.length;
    const stored = items.map((item) => structuredClone(item));
    this.target.push(...stored);
    this.tracker.patches.push({
      op: "splice",
      path: this.base(),
      index,
      remove: 0,
      add: stored.map((item) => structuredClone(item)),
    });
    return this.target.length;
  };

  private readonly pop = (): JsonPatchValue | undefined => {
    if (this.target.length === 0) return undefined;
    const index = this.target.length - 1;
    const removed = this.target.pop();
    this.tracker.patches.push({
      op: "splice",
      path: this.base(),
      index,
      remove: 1,
      add: [],
    });
    return removed;
  };

  private readonly shift = (): JsonPatchValue | undefined => {
    if (this.target.length === 0) return undefined;
    const removed = this.target.shift();
    this.tracker.patches.push({
      op: "splice",
      path: this.base(),
      index: 0,
      remove: 1,
      add: [],
    });
    return removed;
  };

  private readonly unshift = (...items: JsonPatchValue[]): number => {
    const stored = items.map((item) => structuredClone(item));
    this.target.unshift(...stored);
    this.tracker.patches.push({
      op: "splice",
      path: this.base(),
      index: 0,
      remove: 0,
      add: stored.map((item) => structuredClone(item)),
    });
    return this.target.length;
  };

  private readonly splice = (
    start?: number,
    deleteCount?: number,
    ...items: JsonPatchValue[]
  ): JsonPatchValue[] => {
    if (start === undefined) return [];
    const len = this.target.length;
    const index = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const stored = items.map((item) => structuredClone(item));
    // splice(start) deletes through the end, whereas splice(start, undefined)
    // deletes nothing, so the two cases must be distinguished.
    const removed =
      deleteCount === undefined
        ? this.target.splice(index)
        : this.target.splice(index, deleteCount, ...stored);
    this.tracker.patches.push({
      op: "splice",
      path: this.base(),
      index,
      remove: removed.length,
      add: stored.map((item) => structuredClone(item)),
    });
    return removed;
  };

  private readonly reverse = (): object => {
    this.target.reverse();
    this.emitReplaceWhole();
    return this.self();
  };

  private readonly sort = (
    compare?: (a: JsonPatchValue, b: JsonPatchValue) => number
  ): object => {
    this.target.sort(compare);
    this.emitReplaceWhole();
    return this.self();
  };

  private readonly fill = (
    value: JsonPatchValue,
    start?: number,
    end?: number
  ): object => {
    this.target.fill(structuredClone(value), start, end);
    this.emitReplaceWhole();
    return this.self();
  };

  private readonly copyWithin = (
    target: number,
    start: number,
    end?: number
  ): object => {
    this.target.copyWithin(target, start, end);
    this.emitReplaceWhole();
    return this.self();
  };

  get(target: JsonArray, key: string | symbol): unknown {
    if (typeof key === "string") {
      switch (key) {
        case "push":
          return this.push;
        case "pop":
          return this.pop;
        case "shift":
          return this.shift;
        case "unshift":
          return this.unshift;
        case "splice":
          return this.splice;
        case "reverse":
          return this.reverse;
        case "sort":
          return this.sort;
        case "fill":
          return this.fill;
        case "copyWithin":
          return this.copyWithin;
      }
      const index = toIndex(key);
      if (index !== undefined) {
        const value = target[index];
        if (isContainer(value))
          return this.tracker.proxyFor(value, target, index);
        return value;
      }
    }
    return Reflect.get(target, key) as unknown;
  }

  set(target: JsonArray, key: string | symbol, value: unknown): boolean {
    if (typeof key === "symbol") return Reflect.set(target, key, value);
    if (key === "length") {
      const oldLength = target.length;
      const newLength = Number(value);
      target.length = newLength;
      if (newLength < oldLength) {
        this.tracker.patches.push({
          op: "splice",
          path: this.base(),
          index: newLength,
          remove: oldLength - newLength,
          add: [],
        });
      } else if (newLength > oldLength) {
        // The new slots are holes, which serialize to null.
        this.tracker.patches.push({
          op: "splice",
          path: this.base(),
          index: oldLength,
          remove: 0,
          add: new Array<JsonPatchValue>(newLength - oldLength).fill(null),
        });
      }
      return true;
    }
    const index = toIndex(key);
    if (index === undefined) return Reflect.set(target, key, value);
    const stored = structuredClone(value as JsonPatchValue);
    if (index < target.length) {
      target[index] = stored;
      this.tracker.patches.push({
        op: "replace",
        path: appendPointer(this.base(), index),
        value: structuredClone(stored),
      });
    } else {
      // Appending at or past the end. Any skipped slots become null holes.
      const oldLength = target.length;
      target[index] = stored;
      const add: JsonPatchValue[] = [];
      for (let i = oldLength; i < index; i++) add.push(null);
      add.push(structuredClone(stored));
      this.tracker.patches.push({
        op: "splice",
        path: this.base(),
        index: oldLength,
        remove: 0,
        add,
      });
    }
    return true;
  }

  deleteProperty(target: JsonArray, key: string | symbol): boolean {
    if (typeof key === "symbol") return Reflect.deleteProperty(target, key);
    const index = toIndex(key);
    if (index !== undefined && index < target.length) {
      // Deleting an array index leaves a hole, which serializes to null.
      delete target[index];
      this.tracker.patches.push({
        op: "replace",
        path: appendPointer(this.base(), index),
        value: null,
      });
      return true;
    }
    return Reflect.deleteProperty(target, key);
  }
}

function finishFn(
  tracker: JsonTracker
): () => { value: JsonPatchValue; updates: JsonPatchExtended[] } {
  return () => ({
    value: structuredClone(tracker.root),
    updates: tracker.patches,
  });
}

function toImmutableFn(tracker: JsonTracker): () => JsonPatchValue {
  return () => structuredClone(tracker.root);
}

/* -------------------------------------------------------------------------- */
/* Applying patches.                                                          */
/* -------------------------------------------------------------------------- */

/** Indexes into a container by a (string) path segment. */
function getChild(container: JsonContainer, segment: string): JsonPatchValue {
  if (Array.isArray(container)) return container[Number(segment)];
  return container[segment];
}

/** Navigates from `root` along `segments`, returning the container reached. */
function navigate(root: JsonContainer, segments: string[]): JsonContainer {
  let current: JsonContainer = root;
  for (const segment of segments) {
    const next = getChild(current, segment);
    if (!isContainer(next)) {
      throw new Error(
        `JSON patch path does not point to a container: /${segments.join("/")}`
      );
    }
    current = next;
  }
  return current;
}

function applyPatch(root: JsonObject, patch: JsonPatchExtended): void {
  const segments = parsePointer(patch.path);

  if (patch.op === "splice") {
    const array = navigate(root, segments);
    if (!Array.isArray(array)) {
      throw new Error(
        `JSON splice patch does not target an array: ${patch.path}`
      );
    }
    array.splice(
      patch.index,
      patch.remove,
      ...patch.add.map((v) => structuredClone(v))
    );
    return;
  }

  const last = segments[segments.length - 1];
  const parent = navigate(root, segments.slice(0, -1));

  switch (patch.op) {
    case "add":
      if (Array.isArray(parent)) {
        const index = last === "-" ? parent.length : Number(last);
        parent.splice(index, 0, structuredClone(patch.value));
      } else {
        parent[last] = structuredClone(patch.value);
      }
      break;
    case "replace":
      if (Array.isArray(parent))
        parent[Number(last)] = structuredClone(patch.value);
      else parent[last] = structuredClone(patch.value);
      break;
    case "remove":
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Model definition.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Defines a {@link DefModel} for a JSON-serializable value type `T`.
 *
 * The mutable value behaves like a plain (mutable) `T`: you read and write its
 * properties, mutate nested objects, and call array methods directly. Behind
 * the scenes, a tree of {@link Proxy}s records every change as a
 * {@link JsonPatchExtended}, which can later be replayed with `applyUpdates`.
 *
 * Limitations:
 * - Type `T` must have readonly `type` and `id` properties.
 * - Values must be pure JSON - no classes, Dates, circular references, etc.
 * - The JSON value must **not** have top-level properties names that start with an underscore.
 * Those could conflict with internal methods added to MutableValues.
 * - Objects and arrays inserted into the JSON value are deep-copied,
 * so the patches don't reflect their future internal changes.
 *
 * @typeParam T The mutable value type.
 * The (immutable) value type is then `Readonly<T>`.
 */
export function defineJsonModel<T extends BaseValue>(): DefModel<
  Readonly<T>,
  T & MutableValue<Readonly<T>, JsonPatchExtended>,
  JsonPatchExtended
> {
  return defineModel<
    Readonly<T>,
    T & MutableValue<Readonly<T>, JsonPatchExtended>,
    JsonPatchExtended
  >({
    toMutable(value) {
      const tracker = new JsonTracker(
        structuredClone(value as unknown as JsonObject)
      );
      return tracker.proxyFor(tracker.root, null, "") as unknown as T &
        MutableValue<Readonly<T>, JsonPatchExtended>;
    },
    applyUpdates(value, updates) {
      const root = structuredClone(value as unknown as JsonObject);
      for (const patch of updates) applyPatch(root, patch);
      return root as unknown as Readonly<T>;
    },
  });
}
