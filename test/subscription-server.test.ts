import { assert } from "chai";
import { describe, it } from "mocha";

import { BiMap } from "../src/data-structures/bi-map";
import { ChangeSet } from "../src/data-structures/change-set";
import { SubscriptionDelta } from "../src/data-structures/subscription-delta";
import { SubscriptionServer } from "../src/subscription-server";
import { GetState } from "../src/types/get-state";
import { BaseValue } from "../src/types/model";
import { Counter, Register, TTM, typeToModel } from "./test-models";

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function counter(id: string, count: number): Counter {
  return { type: "counter", id, count };
}

function register(id: string, value: string): Register {
  return { type: "register", id, value };
}

function emptyChangeSet(): ChangeSet<TTM> {
  return new ChangeSet(typeToModel);
}

/** Builds a ChangeSet from the given blind sets, updates, and deletes. */
function changeSet(
  blindSets: Array<Counter | Register> = [],
  updates: Array<{ value: Counter | Register; updates: object[] }> = [],
  deletes: Array<{ type: keyof TTM; id: string }> = []
): ChangeSet<TTM> {
  const result = emptyChangeSet();
  for (const value of blindSets) {
    result.blindSets.set(value.type, value.id, value);
  }
  for (const update of updates) {
    result.updates.set(update.value.type, update.value.id, update.updates);
  }
  for (const { type, id } of deletes) {
    result.deletes.add(type, id);
  }
  return result;
}

/** A GetState backed by a fixed BiMap of values. */
function stateOf(values: Array<Counter | Register>): GetState<TTM> {
  const map = new BiMap<TTM, BaseValue>();
  for (const value of values) {
    map.set(value.type, value.id, value);
  }
  return {
    get: (type, id) => map.get(type, id),
  };
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe("SubscriptionServer", () => {
  it("returns an empty ChangeSet when there are no subscriptions", () => {
    const server = new SubscriptionServer(typeToModel);
    const result = server.processChanges(
      [changeSet([counter("a", 1)])],
      null,
      stateOf([])
    );
    assert.strictEqual(result.blindSets.size, 0);
    assert.strictEqual(result.updates.size, 0);
    assert.strictEqual(result.deletes.size, 0);
  });

  it("blind-sets the current value for a newly-added subscription", () => {
    const server = new SubscriptionServer(typeToModel);
    const delta = new SubscriptionDelta<TTM>();
    delta.add("counter", "a");

    const result = server.processChanges(
      [],
      delta,
      stateOf([counter("a", 10)])
    );

    assert.deepStrictEqual(
      result.blindSets.get("counter", "a"),
      counter("a", 10)
    );
  });

  it("omits a newly-added subscription with no current value", () => {
    const server = new SubscriptionServer(typeToModel);
    const delta = new SubscriptionDelta<TTM>();
    delta.add("counter", "missing");

    const result = server.processChanges([], delta, stateOf([]));

    assert.isFalse(result.blindSets.has("counter", "missing"));
  });

  it("includes changes to already-subscribed values", () => {
    const server = new SubscriptionServer(typeToModel);
    const delta = new SubscriptionDelta<TTM>();
    delta.add("counter", "a");
    server.processChanges([], delta, stateOf([counter("a", 10)]));

    const result = server.processChanges(
      [changeSet([], [{ value: counter("a", 11), updates: [{ delta: 1 }] }])],
      null,
      stateOf([counter("a", 11)])
    );

    assert.deepStrictEqual(result.updates.get("counter", "a"), [{ delta: 1 }]);
  });

  it("excludes changes to values that are not subscribed", () => {
    const server = new SubscriptionServer(typeToModel);

    const result = server.processChanges(
      [changeSet([counter("a", 1)], [], []), changeSet([register("r", "x")])],
      null,
      stateOf([])
    );

    assert.strictEqual(result.blindSets.size, 0);
  });

  it("excludes changes to a value unsubscribed in the same call", () => {
    const server = new SubscriptionServer(typeToModel);
    const addDelta = new SubscriptionDelta<TTM>();
    addDelta.add("counter", "a");
    server.processChanges([], addDelta, stateOf([counter("a", 10)]));

    const deleteDelta = new SubscriptionDelta<TTM>();
    deleteDelta.delete("counter", "a");
    const result = server.processChanges(
      [changeSet([counter("a", 99)])],
      deleteDelta,
      stateOf([counter("a", 99)])
    );

    assert.isFalse(result.blindSets.has("counter", "a"));
    assert.isFalse(result.deletes.has("counter", "a"));
  });

  it("stops including changes for a value unsubscribed in an earlier call", () => {
    const server = new SubscriptionServer(typeToModel);
    const addDelta = new SubscriptionDelta<TTM>();
    addDelta.add("counter", "a");
    server.processChanges([], addDelta, stateOf([counter("a", 10)]));

    const deleteDelta = new SubscriptionDelta<TTM>();
    deleteDelta.delete("counter", "a");
    server.processChanges([], deleteDelta, stateOf([counter("a", 10)]));

    const result = server.processChanges(
      [changeSet([counter("a", 20)])],
      null,
      stateOf([counter("a", 20)])
    );

    assert.isFalse(result.blindSets.has("counter", "a"));
  });

  it("uses the final state value rather than the changeSet's update for a newly-added subscription", () => {
    const server = new SubscriptionServer(typeToModel);
    const delta = new SubscriptionDelta<TTM>();
    delta.add("counter", "a");

    const result = server.processChanges(
      [changeSet([], [{ value: counter("a", 5), updates: [{ delta: 5 }] }])],
      delta,
      stateOf([counter("a", 5)])
    );

    assert.deepStrictEqual(
      result.blindSets.get("counter", "a"),
      counter("a", 5)
    );
    assert.isFalse(result.updates.has("counter", "a"));
  });
});
