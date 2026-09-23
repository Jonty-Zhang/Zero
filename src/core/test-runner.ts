import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckDefinition, CheckResult } from "../domain/types.js";

export interface TestRunnerOptions {
  timeoutMs?: number;
  logDirectory?: string;
  /** Upper bound per output stream; output beyond this is discarded. */
  maxLogBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

export class TestRunner {
  readonly #timeoutMs: number;
  readonly #logDirectory?: string;
  readonly #maxLogBytes: number;
  readonly #environment?: NodeJS.ProcessEnv;

  constructor(options: TestRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.#logDirectory = options.logDirectory;
    this.#maxLogBytes = options.maxLogBytes ?? 20 * 1024 * 1024;
    this.#environment = options.environment;
    if (this.#timeoutMs <= 0 || this.#maxLogBytes <= 0) throw new Error("timeoutMs and maxLogBytes must be positive");
  }

  async run(checks: CheckDefinition[], cwd: string, options: { signal?: AbortSignal } = {}): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const check of checks) results.push(await this.runOne(check, cwd, options));
    return results;
  }

  async runOne(check: CheckDefinition, cwd: string, options: { signal?: AbortSignal } = {}): Promise<CheckResult> {
    options.signal?.throwIfAborted();
    if (!check.id || !Array.isArray(check.argv) || check.argv.length === 0 || !check.argv[0]) {
      throw new Error("Check requires an id and a non-empty argv array");
    }
    const started = Date.now();
    const logName = `${basename(check.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}`;
    let stdoutPath: string | undefined;
    let stderrPath: string | undefined;
    let stdoutFile: ReturnType<typeof createWriteStream> | undefined;
    let stderrFile: ReturnType<typeof createWriteStream> | undefined;
    if (this.#logDirectory) {
      await mkdir(this.#logDirectory, { recursive: true });
      stdoutPath = resolve(this.#logDirectory, `${logName}.stdout.log`);
      stderrPath = resolve(this.#logDirectory, `${logName}.stderr.log`);
      stdoutFile = createWriteStream(stdoutPath, { flags: "wx" });
      stderrFile = createWriteStream(stderrPath, { flags: "wx" });
    }
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let logTruncated = false;
    let spawnError: string | undefined;
    const child = spawn(check.argv[0], check.argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: this.#safeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tee = (stream: NodeJS.ReadableStream, file: ReturnType<typeof createWriteStream> | undefined, size: () => number, setSize: (n: number) => void) => {
      stream.on("data", (chunk: Buffer) => {
        const next = size() + chunk.length;
        if (file && size() < this.#maxLogBytes) {
          const allowed = Math.max(0, this.#maxLogBytes - size());
          if (allowed) file.write(chunk.subarray(0, allowed));
        }
        if (next > this.#maxLogBytes) logTruncated = true;
        setSize(next);
      });
    };
    tee(child.stdout!, stdoutFile, () => stdoutSize, n => { stdoutSize = n; });
    tee(child.stderr!, stderrFile, () => stderrSize, n => { stderrSize = n; });

    let cancelled = options.signal?.aborted ?? false;
    const exitCode = await new Promise<number | null>(resolveExit => {
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        resolveExit(code);
      };
      const terminate = () => {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
          const fallback = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2_000);
          killer.once("close", () => { clearTimeout(fallback); if (child.exitCode === null) child.kill(); });
          killer.once("error", () => { clearTimeout(fallback); if (child.exitCode === null) child.kill(); });
          return;
        }
        try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
        killTimer = setTimeout(() => {
          try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, 1_000);
        killTimer.unref?.();
      };
      const onAbort = () => { cancelled = true; terminate(); };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, this.#timeoutMs);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", error => { spawnError = error.message; finish(null); });
      child.once("close", code => finish(code));
    });
    await Promise.all([new Promise<void>(r => stdoutFile?.end(r) ?? r()), new Promise<void>(r => stderrFile?.end(r) ?? r())]);
    if (logTruncated) {
      await Promise.all([
        stdoutPath ? new Promise<void>(r => { const file = createWriteStream(stdoutPath!, { flags: "a" }); file.end("\n[Zero truncated log at configured byte limit]\n", r); }) : Promise.resolve(),
        stderrPath ? new Promise<void>(r => { const file = createWriteStream(stderrPath!, { flags: "a" }); file.end("\n[Zero truncated log at configured byte limit]\n", r); }) : Promise.resolve(),
      ]);
    }
    return {
      id: check.id,
      argv: [...check.argv],
      status: spawnError ? "spawn_error" : timedOut ? "timed_out" : exitCode === 0 && !cancelled ? "passed" : "failed",
      exitCode,
      durationMs: Date.now() - started,
      stdoutPath,
      stderrPath,
      logTruncated,
      error: spawnError ?? (cancelled ? "Check cancelled" : undefined),
    };
  }

  #safeEnvironment(): NodeJS.ProcessEnv {
    const names = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL"];
    const env: NodeJS.ProcessEnv = {};
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    for (const [name, value] of Object.entries(this.#environment ?? {})) {
      if (value !== undefined) env[name] = value;
    }
    return env;
  }
}
