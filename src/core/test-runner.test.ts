import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TestRunner } from "./test-runner.js";

test("failed checks retain observed streams without log files, including empty output and timeout", async () => {
  const runner = new TestRunner();
  const failed = await runner.runOne({ id: "failure", argv: [process.execPath, "-e", "process.stdout.write('原因😀');process.stderr.write('bad\\n\\u0000');process.exitCode=23"] }, process.cwd());
  assert.equal(failed.exitCode, 23);
  assert.equal(failed.stdoutPath, undefined);
  assert.deepEqual(failed.diagnostics, { stdout: { text: "原因😀", truncated: false }, stderr: { text: "bad\n\u0000", truncated: false } });
  const empty = await runner.runOne({ id: "empty", argv: [process.execPath, "-e", ""] }, process.cwd());
  assert.deepEqual(empty.diagnostics, { stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false } });
  const timed = await new TestRunner({ timeoutMs: 800 }).runOne({ id: "timeout", argv: [process.execPath, "-e", "process.stdout.write('before-timeout');setInterval(()=>{},100)"] }, process.cwd());
  assert.equal(timed.status, "timed_out");
  assert.equal(timed.diagnostics?.stdout.text, "before-timeout");
  const missing = await runner.runOne({ id: "missing", argv: [join(process.cwd(), "missing-round31.exe")] }, process.cwd());
  assert.equal(missing.status, "spawn_error");
  assert.equal(missing.diagnostics, undefined);
});

test("diagnostic head and tail survive full log truncation with UTF8 byte bounds", async () => {
  const logs = await mkdtemp(join(tmpdir(), "zero-diagnostics-"));
  try {
    const result = await new TestRunner({ logDirectory: logs, maxLogBytes: 8 }).runOne({ id: "long", argv: [process.execPath, "-e", "process.stdout.write('HEAD'+ '中😀'.repeat(5000)+'TAIL');process.stderr.write('stderr-tail')"] }, process.cwd());
    assert.equal(result.logTruncated, true);
    const snapshot = result.diagnostics!.stdout;
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(snapshot.text, 'utf8') <= 4096);
    assert.match(snapshot.text, /^HEAD/);
    assert.match(snapshot.text, /TAIL$/);
    assert.match(snapshot.text, /omitted/);
    assert.doesNotMatch(snapshot.text, /�/);
    assert.equal(result.diagnostics!.stderr.truncated, false);
    assert.doesNotMatch(await readFile(result.stdoutPath!, 'utf8'), /TAIL/);
  } finally { await rm(logs, { recursive: true, force: true }); }
});

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
