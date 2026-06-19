import { assert } from "chai";
import { describe, it } from "mocha";

import { Log2Log } from "../src/log2log";
import {
  BaseTypeToModel,
  BaseValue,
  MutableValue,
  ValueType,
  defineModel,
} from "../src/model";
import { ValueStore } from "../src/store";

/* -------------------------------------------------------------------------- */
/* Made-up models for testing.                                                */
/* -------------------------------------------------------------------------- */

/** A counter whose mutable tracks additive changes (commit() -> deltas). */
interface Counter extends BaseValue<"counter"> {
  readonly count: number;
}
interface CounterUpdate {
  readonly delta: number;
}
class CounterMutable implements MutableValue<Counter, CounterUpdate> {
  private base: Counter;
  private pending = 0;

  constructor(value: Counter) {
    this.base = value;
  }

  add(delta: number): void {
    this.pending += delta;
  }

  _getUpdates(): CounterUpdate[] {
    return this.pending !== 0 ? [{ delta: this.pending }] : [];
  }
  _toImmutable(): Counter {
    return { ...this.base, count: this.base.count + this.pending };
  }
}

/** A last-writer-wins string register. */
interface Register extends BaseValue<"register"> {
  readonly value: string;
}
interface RegisterUpdate {
  readonly value: string;
}
class RegisterMutable implements MutableValue<Register, RegisterUpdate> {
  private current: Register;
  private changed = false;

  constructor(value: Register) {
    this.current = value;
  }

  setValue(value: string): void {
    this.current = { ...this.current, value };
    this.changed = true;
  }

  _getUpdates(): RegisterUpdate[] {
    return this.changed ? [{ value: this.current.value }] : [];
  }
  _toImmutable(): Register {
    return this.current;
  }
}

const typeToModel = {
  counter: defineModel<Counter, CounterMutable, CounterUpdate>({
    toMutable: (value) => new CounterMutable(value),
    applyUpdates: (value, updates) => ({
      ...value,
      count: value.count + updates.reduce((sum, u) => sum + u.delta, 0),
    }),
  }),
  register: defineModel<Register, RegisterMutable, RegisterUpdate>({
    toMutable: (value) => new RegisterMutable(value),
    applyUpdates: (value, updates) =>
      updates.length === 0
        ? value
        : { ...value, value: updates[updates.length - 1].value },
  }),
};
type TTM = typeof typeToModel;

/* -------------------------------------------------------------------------- */
/* A trivial in-memory ValueStore.                                            */
/* -------------------------------------------------------------------------- */

class MemoryStore<T extends BaseTypeToModel> implements ValueStore<T> {
  private readonly data = new Map<string, BaseValue>();

  private key(type: string, id: string): string {
    return `${type}:${id}`;
  }

  get<K extends keyof T>(type: K, id: string): ValueType<T, K> | null {
    return (
      (this.data.get(this.key(type as string, id)) as ValueType<T, K>) ?? null
    );
  }
  getAll<K extends keyof T>(type: K, ids: string[]): ValueType<T, K>[] {
    const result: ValueType<T, K>[] = [];
    for (const id of ids) {
      const value = this.get(type, id);
      if (value !== null) result.push(value);
    }
    return result;
  }
  set<K extends keyof T>(value: ValueType<T, K>): void {
    this.data.set(this.key(value.type, value.id), value);
  }
}

function newLog2Log(): Log2Log<TTM> {
  const store = new MemoryStore<TTM>();
  store.set<"counter">({ type: "counter", id: "a", count: 10 });
  store.set<"register">({ type: "register", id: "r", value: "initial" });
  return new Log2Log(typeToModel, store);
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("Transaction", () => {
  it("reads fall through to the store", () => {
    const tx = newLog2Log().beginTransaction();
    assert.deepEqual(tx.get("counter", "a"), {
      type: "counter",
      id: "a",
      count: 10,
    });
    assert.isNull(tx.get("counter", "missing"));
  });

  it("set affects future get and getMutable, but not the store", () => {
    const l2l = newLog2Log();
    const tx = l2l.beginTransaction();

    tx.set<"counter">({ type: "counter", id: "a", count: 99 });
    assert.deepEqual(tx.get("counter", "a"), {
      type: "counter",
      id: "a",
      count: 99,
    });
    // getMutable sees the set value.
    assert.deepEqual(tx.getMutable("counter", "a")!._toImmutable(), {
      type: "counter",
      id: "a",
      count: 99,
    });
    // Store is untouched.
    assert.deepEqual(l2l.store.get("counter", "a"), {
      type: "counter",
      id: "a",
      count: 10,
    });
  });

  it("mutating a mutable affects future get", () => {
    const tx = newLog2Log().beginTransaction();
    const mut = tx.getMutable("counter", "a")!;
    mut.add(5);
    assert.deepEqual(tx.get("counter", "a"), {
      type: "counter",
      id: "a",
      count: 15,
    });
  });

  it("getMutable twice returns the same mutable", () => {
    const tx = newLog2Log().beginTransaction();
    const first = tx.getMutable("counter", "a");
    const second = tx.getMutable("counter", "a");
    assert.strictEqual(first, second);
  });

  it("getMutable returns null for a missing value with no initialValue", () => {
    const tx = newLog2Log().beginTransaction();
    assert.isNull(tx.getMutable("counter", "missing"));
  });

  it("getChanges reports updates for mutated store values", () => {
    const tx = newLog2Log().beginTransaction();
    tx.getMutable("counter", "a")!.add(7);
    tx.getMutable("register", "r")!.setValue("hello");

    const { sets, updates } = tx.getChanges();
    assert.strictEqual(sets.size, 0);
    assert.deepEqual(updates.get("counter", "a"), [{ delta: 7 }]);
    assert.deepEqual(updates.get("register", "r"), [{ value: "hello" }]);
  });

  it("getChanges omits mutables that were not changed", () => {
    const tx = newLog2Log().beginTransaction();
    tx.getMutable("counter", "a"); // touched but not changed
    const { sets, updates } = tx.getChanges();
    assert.strictEqual(sets.size, 0);
    assert.strictEqual(updates.size, 0);
  });

  it("getChanges reports blind sets as sets", () => {
    const tx = newLog2Log().beginTransaction();
    tx.set<"counter">({ type: "counter", id: "b", count: 3 });

    const { sets, updates } = tx.getChanges();
    assert.strictEqual(updates.size, 0);
    assert.deepEqual(sets.get("counter", "b") as Counter, {
      type: "counter",
      id: "b",
      count: 3,
    });
  });

  it("getMutable with initialValue creates a new value, committed as a set", () => {
    const tx = newLog2Log().beginTransaction();
    const mut = tx.getMutable("counter", "new", {
      type: "counter",
      id: "new",
      count: 1,
    });
    // Even with no further changes, the initialValue is committed as a set.
    const { sets, updates } = tx.getChanges();
    assert.strictEqual(updates.size, 0);
    assert.deepEqual(sets.get("counter", "new") as Counter, {
      type: "counter",
      id: "new",
      count: 1,
    });
    assert.deepEqual(mut._toImmutable(), {
      type: "counter",
      id: "new",
      count: 1,
    });
  });

  it("changes to an initialValue mutable are folded into its set", () => {
    const tx = newLog2Log().beginTransaction();
    const mut = tx.getMutable("counter", "new", {
      type: "counter",
      id: "new",
      count: 1,
    });
    mut.add(4);
    assert.deepEqual(tx.get("counter", "new"), {
      type: "counter",
      id: "new",
      count: 5,
    });

    const { sets, updates } = tx.getChanges();
    assert.strictEqual(updates.size, 0);
    assert.deepEqual(sets.get("counter", "new") as Counter, {
      type: "counter",
      id: "new",
      count: 5,
    });
  });

  it("getMutable after set commits as a set, not updates", () => {
    const tx = newLog2Log().beginTransaction();
    // 'b' does not exist in the store.
    tx.set<"counter">({ type: "counter", id: "b", count: 3 });
    tx.getMutable("counter", "b")!.add(2);

    const { sets, updates } = tx.getChanges();
    assert.strictEqual(updates.size, 0);
    assert.deepEqual(sets.get("counter", "b") as Counter, {
      type: "counter",
      id: "b",
      count: 5,
    });
  });

  it("set overrides an active mutable; its changes are not committed", () => {
    const tx = newLog2Log().beginTransaction();
    tx.getMutable("counter", "a")!.add(100);
    // Blind set overrides the mutable.
    tx.set<"counter">({ type: "counter", id: "a", count: 0 });

    assert.deepEqual(tx.get("counter", "a"), {
      type: "counter",
      id: "a",
      count: 0,
    });

    const { sets, updates } = tx.getChanges();
    assert.strictEqual(updates.size, 0);
    assert.deepEqual(sets.get("counter", "a") as Counter, {
      type: "counter",
      id: "a",
      count: 0,
    });
  });

  it("getAll and getAllMutable skip missing ids and reflect local state", () => {
    const tx = newLog2Log().beginTransaction();
    tx.set<"counter">({ type: "counter", id: "b", count: 3 });

    assert.deepEqual(tx.getAll("counter", ["a", "missing", "b"]), [
      { type: "counter", id: "a", count: 10 },
      { type: "counter", id: "b", count: 3 },
    ]);

    const mutables = tx.getAllMutable("counter", ["a", "missing", "b"]);
    assert.strictEqual(mutables.length, 2);
    assert.deepEqual(mutables[0]._toImmutable(), {
      type: "counter",
      id: "a",
      count: 10,
    });
    assert.deepEqual(mutables[1]._toImmutable(), {
      type: "counter",
      id: "b",
      count: 3,
    });
  });
});
