import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeReportProjection, verifyReportProjection } from "./report-projection.js";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-report-projection-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("materializes report bytes and verifies the exact SHA-256", async () => withDirectory(async directory => {
  const bytes = Buffer.from('{"ok":true}\n', "utf8");
  await materializeReportProjection(directory, "report.json", bytes, hash(bytes));
  assert.deepEqual(await readFile(path.join(directory, "report.json")), bytes);
  assert.equal(await verifyReportProjection(directory, "report.json", hash(bytes)), true);
  assert.equal(await verifyReportProjection(directory, "result.diff", hash(bytes)), false);
}));

test("repairs a corrupted projection from trusted bytes", async () => withDirectory(async directory => {
  const bytes = Buffer.from("fixed result\n", "utf8");
  const destination = path.join(directory, "result.diff");
  await writeFile(destination, "corrupt\n");
  assert.equal(await verifyReportProjection(directory, "result.diff", hash(bytes)), false);
  await materializeReportProjection(directory, "result.diff", bytes, hash(bytes));
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(await verifyReportProjection(directory, "result.diff", hash(bytes)), true);
}));

test("matching projection is a no-op", async () => withDirectory(async directory => {
  const bytes = Buffer.from("unchanged\n", "utf8");
  const destination = path.join(directory, "report.json");
  await writeFile(destination, bytes);
  const before = await (await import("node:fs/promises")).stat(destination);
  await materializeReportProjection(directory, "report.json", bytes, hash(bytes));
  const after = await (await import("node:fs/promises")).stat(destination);
  assert.equal(after.ino, before.ino);
  assert.equal((await readdir(directory)).length, 1);
}));

test("rejects unsafe paths and preserves cleanup after replacement failure", async () => withDirectory(async directory => {
  const bytes = Buffer.from("result", "utf8");
  await assert.rejects(materializeReportProjection(directory, "../escape", bytes, hash(bytes)), /safe path component/);

  const blockedDestination = path.join(directory, "result.diff");
  await mkdir(blockedDestination);
  await assert.rejects(materializeReportProjection(directory, "result.diff", bytes, hash(bytes)));
  assert.deepEqual((await readdir(directory)).sort(), ["result.diff"]);
}));

test("fails closed when the destination is a symlink", async () => withDirectory(async directory => {
  const target = path.join(directory, "target.txt");
  await writeFile(target, "keep me");
  const destination = path.join(directory, "report.json");
  try {
    await symlink(target, destination, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return; // Symlink creation may require Windows developer mode.
    throw error;
  }
  const bytes = Buffer.from("replacement", "utf8");
  await assert.rejects(materializeReportProjection(directory, "report.json", bytes, hash(bytes)), /Unsafe projection destination/);
  assert.equal(await readFile(target, "utf8"), "keep me");
}));

test("rejects bytes that do not match the database-fixed digest", async () => withDirectory(async directory => {
  await assert.rejects(materializeReportProjection(directory, "report.json", Buffer.from("wrong"), "0".repeat(64)), /do not match/);
}));
