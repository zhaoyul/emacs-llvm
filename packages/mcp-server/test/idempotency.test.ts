import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyCache } from "../src/idempotency.js";

test("IdempotencyCache expires entries deterministically and evicts the oldest live entry", () => {
  let now = 1_000;
  const expiring = new IdempotencyCache<string>(10, 10, () => now);
  expiring.set("a", "one");
  assert.equal(expiring.get("a"), "one");
  now = 1_009;
  assert.equal(expiring.get("a"), "one");
  now = 1_010;
  assert.equal(expiring.get("a"), undefined);

  now = 2_000;
  const bounded = new IdempotencyCache<string>(60_000, 2, () => now);
  bounded.set("a", "one");
  now += 1;
  bounded.set("b", "two");
  now += 1;
  bounded.set("c", "three");
  assert.equal(bounded.get("a"), undefined);
  assert.equal(bounded.get("b"), "two");
  assert.equal(bounded.get("c"), "three");
});

test("IdempotencyCache refreshes an existing key without evicting another live entry", () => {
  let now = 100;
  const cache = new IdempotencyCache<string>(100, 2, () => now);
  cache.set("a", "one");
  now += 1;
  cache.set("b", "two");
  now += 1;
  cache.set("a", "one-refreshed");

  assert.equal(cache.get("a"), "one-refreshed");
  assert.equal(cache.get("b"), "two");
});

test("IdempotencyCache rejects invalid capacity and TTL", () => {
  assert.throws(() => new IdempotencyCache<string>(0, 1), RangeError);
  assert.throws(() => new IdempotencyCache<string>(1, 0), RangeError);
});
