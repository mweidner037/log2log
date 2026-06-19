import { assert } from "chai";
import { describe, it } from "mocha";

import { ChangeSet, Log2Log } from "../src/log2log";
import { BaseValue, MutableValue, defineModel } from "../src/model";
import { SavedState } from "../src/saved-state";

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

  _finish(): { value: Counter; updates: CounterUpdate[] } {
    return {
      value: this._toImmutable(),
      updates: this.pending !== 0 ? [{ delta: this.pending }] : [],
    };
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

  _finish(): { value: Register; updates: RegisterUpdate[] } {
    return {
      value: this.current,
      updates: this.changed ? [{ value: this.current.value }] : [],
    };
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
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function newLog2Log(): Log2Log<TTM> {
  const initialState: SavedState<TTM> = {
    counter: [{ type: "counter", id: "a", count: 10 }],
    register: [{ type: "register", id: "r", value: "initial" }],
  };
  return new Log2Log(typeToModel, initialState);
}

function findSet<V extends BaseValue>(
  changes: ChangeSet<TTM>,
  type: keyof TTM,
  id: string
): V | undefined {
  return changes.blindSets.get(type, id) as V | undefined;
}

function findUpdate<V extends BaseValue>(
  changes: ChangeSet<TTM>,
  type: keyof TTM,
  id: string
): { value: V; updates: object[] } | undefined {
  return changes.updates.get(type, id) as
    | { value: V; updates: object[] }
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("applyMutations", () => {
  it("reads fall through to the initial state", () => {
    let read: Counter | null | undefined;
    let missing: Counter | null | undefined;
    newLog2Log().applyMutations([
      (tx) => {
        read = tx.get("counter", "a");
        missing = tx.get("counter", "missing");
      },
    ]);
    assert.deepEqual(read, { type: "counter", id: "a", count: 10 });
    assert.isNull(missing);
  });

  it("reports updates for mutated existing values", () => {
    const { errors, changes } = newLog2Log().applyMutations([
      (tx) => {
        tx.getMutable("counter", "a")!.add(7);
        tx.getMutable("register", "r")!.setValue("hello");
      },
    ]);
    assert.deepEqual(errors, [null]);
    assert.strictEqual(changes.blindSets.size, 0);

    const counterUpdate = findUpdate<Counter>(changes, "counter", "a")!;
    assert.deepEqual(counterUpdate.value, {
      type: "counter",
      id: "a",
      count: 17,
    });
    assert.deepEqual(counterUpdate.updates, [{ delta: 7 }]);

    const registerUpdate = findUpdate<Register>(changes, "register", "r")!;
    assert.deepEqual(registerUpdate.value, {
      type: "register",
      id: "r",
      value: "hello",
    });
    assert.deepEqual(registerUpdate.updates, [{ value: "hello" }]);
  });

  it("omits mutables that were touched but not changed", () => {
    const { changes } = newLog2Log().applyMutations([
      (tx) => {
        tx.getMutable("counter", "a");
      },
    ]);
    assert.strictEqual(changes.blindSets.size, 0);
    assert.strictEqual(changes.updates.size, 0);
  });

  it("reports set values as blind sets", () => {
    const { changes } = newLog2Log().applyMutations([
      (tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 }),
    ]);
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "b"), {
      type: "counter",
      id: "b",
      count: 3,
    });
  });

  it("getMutable with initialValue creates a new value, committed as a set", () => {
    const { changes } = newLog2Log().applyMutations([
      (tx) =>
        void tx.getMutable("counter", "new", {
          type: "counter",
          id: "new",
          count: 1,
        }),
    ]);
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "new"), {
      type: "counter",
      id: "new",
      count: 1,
    });
  });

  it("a value created in one mutation is visible to and folds updates from later mutations", () => {
    const { errors, changes } = newLog2Log().applyMutations([
      (tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 }),
      (tx) => {
        // 'b' is now in the state, so it reads as an existing value.
        assert.deepEqual(tx.get("counter", "b"), {
          type: "counter",
          id: "b",
          count: 3,
        });
        tx.getMutable("counter", "b")!.add(2);
      },
    ]);
    assert.deepEqual(errors, [null, null]);
    // Overall, 'b' is new, so it remains a single blind set with the final value.
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "b"), {
      type: "counter",
      id: "b",
      count: 5,
    });
  });

  it("updates to the same existing value across mutations merge into one entry", () => {
    const { changes } = newLog2Log().applyMutations([
      (tx) => tx.getMutable("counter", "a")!.add(5),
      (tx) => tx.getMutable("counter", "a")!.add(3),
    ]);
    assert.strictEqual(changes.blindSets.size, 0);

    const update = findUpdate<Counter>(changes, "counter", "a")!;
    assert.deepEqual(update.value, { type: "counter", id: "a", count: 18 });
    assert.deepEqual(update.updates, [{ delta: 5 }, { delta: 3 }]);
  });

  it("a later blind set overrides earlier updates to the same value", () => {
    const { changes } = newLog2Log().applyMutations([
      (tx) => tx.getMutable("counter", "a")!.add(5),
      (tx) => tx.set<"counter">({ type: "counter", id: "a", count: 0 }),
    ]);
    assert.strictEqual(changes.updates.size, 0);
    assert.deepEqual(findSet<Counter>(changes, "counter", "a"), {
      type: "counter",
      id: "a",
      count: 0,
    });
  });

  it("a failed mutation records the error and does not affect state or changes", () => {
    const boom = new Error("boom");
    const { errors, changes } = newLog2Log().applyMutations([
      (tx) => tx.getMutable("counter", "a")!.add(5),
      () => {
        throw boom;
      },
      (tx) => tx.getMutable("counter", "a")!.add(3),
    ]);
    assert.deepEqual(errors, [null, boom, null]);
    // The failed mutation neither contributed changes nor disturbed the state.
    const update = findUpdate<Counter>(changes, "counter", "a")!;
    assert.deepEqual(update.value, { type: "counter", id: "a", count: 18 });
    assert.deepEqual(update.updates, [{ delta: 5 }, { delta: 3 }]);
  });

  it("getAll and getAllMutable skip missing ids and reflect local state", () => {
    let all: Counter[] = [];
    let mutableCount = 0;
    newLog2Log().applyMutations([
      (tx) => {
        tx.set<"counter">({ type: "counter", id: "b", count: 3 });
        all = tx.getAll("counter", ["a", "missing", "b"]);
        mutableCount = tx.getAllMutable("counter", [
          "a",
          "missing",
          "b",
        ]).length;
      },
    ]);
    assert.deepEqual(all, [
      { type: "counter", id: "a", count: 10 },
      { type: "counter", id: "b", count: 3 },
    ]);
    assert.strictEqual(mutableCount, 2);
  });

  it("save returns the state after applying mutations", () => {
    const l2l = newLog2Log();
    l2l.applyMutations([
      (tx) => tx.getMutable("counter", "a")!.add(5),
      (tx) => tx.set<"counter">({ type: "counter", id: "b", count: 3 }),
      (tx) => tx.getMutable("register", "r")!.setValue("hello"),
    ]);
    const saved = l2l.save();

    const counters = [...saved.counter].sort((x, y) =>
      x.id.localeCompare(y.id)
    );
    assert.deepEqual(counters, [
      { type: "counter", id: "a", count: 15 },
      { type: "counter", id: "b", count: 3 },
    ]);
    assert.deepEqual(saved.register, [
      { type: "register", id: "r", value: "hello" },
    ]);
  });
});
