import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TestRunner } from "./test-runner.js";

test("checks use argv directly, isolate inherited environment, and retain bounded logs", async () => {
  const logs = await mkdtemp(join(tmpdir(), "zero-check-"));
  const previous = process.env.ZERO_TEST_SECRET;
  process.env.ZERO_TEST_SECRET = "must-not-leak";
  try {
    const runner = new TestRunner({ logDirectory: logs, maxLogBytes: 8, environment: { ZERO_VISIBLE: "yes" } });
    const result = await runner.runOne({ id: "safe check", argv: [process.execPath, "-e", "process.stdout.write(String(!!process.env.ZERO_TEST_SECRET)+process.env.ZERO_VISIBLE+'123456789')"] }, process.cwd());
    assert.equal(result.status, "passed");
    assert.equal(result.logTruncated, true);
    const output = await readFile(result.stdoutPath!, "utf8");
    assert.match(output, /falseyes/);
    assert.match(output, /truncated log/);
    assert.doesNotMatch(output, /must-not-leak/);
    const bad = await runner.runOne({ id: "bad", argv: [join(logs, "does-not-exist.exe")] }, process.cwd());
    assert.equal(bad.status, "spawn_error");
  } finally {
    if (previous === undefined) delete process.env.ZERO_TEST_SECRET; else process.env.ZERO_TEST_SECRET = previous;
    await rm(logs, { recursive: true, force: true });
  }
});
