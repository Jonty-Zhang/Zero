import test from "node:test";
import assert from "node:assert/strict";
import { classifyQuota, quotaRetryAt } from "./quota.js";

test("quota classifier extracts explicit Codex reset timestamps and duration hints", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  assert.deepEqual(classifyQuota("You've hit your usage limit. Try again at 2026-09-24T05:00:00Z", now), {
    source: "provider_message", retryAt: "2026-09-24T05:00:00.000Z",
  });
  assert.equal(classifyQuota("You've hit your usage limit. Try again in 2h 30m", now)?.retryAt, "2026-09-24T02:30:00.000Z");
  assert.equal(classifyQuota("You've hit your usage limit", now)?.source, "fallback");
});

test("quota classifier leaves ordinary rate, auth, network, timeout and billing errors alone", () => {
  for (const message of ["Too many requests", "rate limit exceeded", "invalid API key", "ECONNRESET", "ETIMEDOUT", "server overloaded", "insufficient credits", "quota exceeded: insufficient_quota", "usage limit reached: credit_balance_exhausted"]) {
    assert.equal(classifyQuota(message), undefined, message);
  }
});

test("fallback quota checks back off exponentially and cap at six hours", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  assert.equal(Date.parse(quotaRetryAt(1, undefined, now)) - now, 5 * 60_000);
  assert.equal(Date.parse(quotaRetryAt(20, undefined, now)) - now, 6 * 60 * 60_000);
  assert.equal(Date.parse(quotaRetryAt(1, { source: "retry_after", retryAt: new Date(now + 1_000).toISOString() }, now)) - now, 30_000);
});
