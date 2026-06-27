import { BaseValue, MutableValue, defineModel } from "../src/types/model";
import { SavedState } from "../src/types/saved-state";

/* -------------------------------------------------------------------------- */
/* Made-up models for testing.                                                */
/* -------------------------------------------------------------------------- */

/** A counter whose mutable tracks additive changes (commit() -> deltas). */
export interface Counter extends BaseValue<"counter"> {
  readonly count: number;
}
export interface CounterUpdate {
  readonly delta: number;
}
export class CounterMutable implements MutableValue<Counter, CounterUpdate> {
  private base: Counter;
  private pending = 0;

  constructor(value: Counter) {
    this.base = value;
  }

  add(delta: number): void {
    this.pending += delta;
  }

  __finish(): { value: Counter; updates: CounterUpdate[] } {
    return {
      value: this.__toImmutable(),
      updates: this.pending !== 0 ? [{ delta: this.pending }] : [],
    };
  }
  __toImmutable(): Counter {
    return { ...this.base, count: this.base.count + this.pending };
  }
}

/** A last-writer-wins string register. */
export interface Register extends BaseValue<"register"> {
  readonly value: string;
}
export interface RegisterUpdate {
  readonly value: string;
}
export class RegisterMutable implements MutableValue<Register, RegisterUpdate> {
  private current: Register;
  private changed = false;

  constructor(value: Register) {
    this.current = value;
  }

  setValue(value: string): void {
    this.current = { ...this.current, value };
    this.changed = true;
  }

  __finish(): { value: Register; updates: RegisterUpdate[] } {
    return {
      value: this.current,
      updates: this.changed ? [{ value: this.current.value }] : [],
    };
  }
  __toImmutable(): Register {
    return this.current;
  }
}

export const typeToModel = {
  counter: defineModel<Counter, CounterMutable, CounterUpdate>({
    toMutable: (value) => new CounterMutable(value),
    applyUpdates: (value, updates) => ({
      ...value,
      count: value.count + updates.reduce((sum, u) => sum + u.delta, 0),
    }),
    save: (value) => value,
    load: (json) => json as Counter,
  }),
  register: defineModel<Register, RegisterMutable, RegisterUpdate>({
    toMutable: (value) => new RegisterMutable(value),
    applyUpdates: (value, updates) =>
      updates.length === 0
        ? value
        : { ...value, value: updates[updates.length - 1].value },
    save: (value) => value,
    load: (json) => json as Register,
  }),
};
export type TTM = typeof typeToModel;

/**
 * Returns a fresh initial state with one counter ("a" = 10) and one register
 * ("r" = "initial").
 */
export function newInitialState(): SavedState {
  return {
    counter: [{ type: "counter", id: "a", count: 10 }],
    register: [{ type: "register", id: "r", value: "initial" }],
  };
}
