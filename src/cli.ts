#!/usr/bin/env node
import { startZeroServer, runBindingVerification, runDshBindingVerification, runZCodeBindingVerification } from './server/main.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';

async function main() {
  if (command === 'serve') {
    const host = option(args, '--host') ?? process.env.ZERO_HOST;
    const port = option(args, '--port');
    assertNoArguments(args);
    const runtime = await startZeroServer({ ...(host ? { host } : {}), ...(port ? { port: Number(port) } : {}) });
    const shutdown = () => { void runtime.close().then(() => process.exit(0)); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    return;
  }
  if (command === 'verify-binding') {
    const harness = args.shift(); const model = args.shift();
    if (!model) throw new Error('Usage: zero verify-binding codex <model-id> [--effort high] | dsh <model-id> --profile <safe-profile> | zcode <model-id> --config-dir <absolute-path> --mode <build|yolo>');
    if (harness === 'codex') {
      const effort = option(args, '--effort') ?? 'high';
      if (args.length) throw new Error('Usage: zero verify-binding codex <model-id> [--effort high]');
      await runBindingVerification(model, effort);
      return;
    }
    if (harness === 'dsh') {
      const profile = option(args, '--profile');
      if (!profile || args.length) throw new Error('Usage: zero verify-binding dsh <model-id> --profile <safe-profile>');
      await runDshBindingVerification(model, profile);
      return;
    }
    if (harness === 'zcode') {
      const configDir = requiredOption(args, '--config-dir');
      const mode = requiredOption(args, '--mode');
      if (args.length) throw new Error('Usage: zero verify-binding zcode <model-id> --config-dir <absolute-path> --mode <build|yolo>');
      await runZCodeBindingVerification(model, configDir, mode);
      return;
    }
    throw new Error('Usage: zero verify-binding codex <model-id> [--effort high] | dsh <model-id> --profile <safe-profile> | zcode <model-id> --config-dir <absolute-path> --mode <build|yolo>');
  }
  if (command === 'submit') {
    const repoPath = requiredOption(args, '--repo');
    const prompt = requiredOption(args, '--prompt');
    const baseRef = option(args, '--base') ?? 'HEAD';
    const acceptanceCriteria = allOptions(args, '--acceptance');
    const checkCommands = allOptions(args, '--check');
    const maxRevisions = Number(option(args, '--max-revisions') ?? 2);
    const harnessId = option(args, '--harness') ?? null;
    const modelId = option(args, '--model') ?? null;
    const reasoningEffort = option(args, '--effort') ?? null;
    assertNoArguments(args);
    const result = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ repoPath, baseRef, prompt, acceptanceCriteria: acceptanceCriteria.join('\n'), checkCommands, maxRevisions, execution: { harnessId, modelId, reasoningEffort } }) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command === 'status') {
    const id = args.shift();
    assertNoArguments(args);
    const result = await request(id ? `/api/tasks/${encodeURIComponent(id)}` : '/api/tasks');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command === 'cancel') {
    const id = args.shift(); if (!id) throw new Error('Usage: zero cancel <task-id>'); assertNoArguments(args);
    const result = await request(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  printHelp();
}

function option(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  values.splice(index, 2); return value;
}
function requiredOption(values: string[], name: string): string { const value = option(values, name); if (!value) throw new Error(`${name} is required`); return value; }
function allOptions(values: string[], name: string): string[] {
  const result: string[] = [];
  let index: number;
  while ((index = values.indexOf(name)) >= 0) {
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    result.push(value); values.splice(index, 2);
  }
  return result;
}
function assertNoArguments(values: string[]) { if (values.length) throw new Error(`Unexpected argument(s): ${values.join(' ')}`); }
async function request(path: string, init?: RequestInit) {
  const base = process.env.ZERO_URL ?? 'http://127.0.0.1:4179';
  const response = await fetch(new URL(path, base), { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Zero API request failed (${response.status})`);
  return text ? JSON.parse(text) as unknown : undefined;
}
function printHelp() {
  process.stdout.write(`Zero task node\n\nCommands:\n  zero serve [--host 127.0.0.1] [--port 4179]\n  zero verify-binding codex <model-id> [--effort high]\n  zero verify-binding dsh <model-id> --profile <safe-profile>\n  zero verify-binding zcode <model-id> --config-dir <absolute-path> --mode <build|yolo>\n  zero submit --repo <path> --prompt <text> [--base <ref>] [--acceptance <text>] [--check <command>] [--max-revisions 2] [--harness <id>] [--model <id>] [--effort <level>]\n  zero status [task-id]\n  zero cancel <task-id>\n\nVerify runs a minimal headless model call. Codex effort levels are registered only after passing that exact effort. DSH and ZCode bindings are pinned to the installed CLI version and never enable reasoning efforts. ZCode requires a preconfigured isolated data directory and explicit build or yolo mode.\nHarness, model and effort are independent optional task overrides.\nSet ZERO_URL to use a non-default local server URL.\n`);
}

void main().catch(error => { console.error(`zero: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
