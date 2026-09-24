import type { HandoffV1 } from "./types.js";

export const HANDOFF_V1_MAX_BYTES = 64 * 1024;

/** Strict runtime validator for the persisted, versioned cross-Harness handoff payload. */
export function parseHandoffV1(value: unknown): HandoffV1 {
  const root = object(value, "handoff", [
    "schemaVersion", "taskId", "stageId", "createdAt", "source", "task", "workspace",
    "completed", "currentState", "decisions", "rejectedOptions", "keyFiles", "checks",
    "blockers", "risks", "nextSteps",
  ]);
  if (root.schemaVersion !== 1) throw new Error("handoff.schemaVersion must be 1");
  const source = object(root.source, "handoff.source", ["attemptId", "harness", "model", "harnessVersion", "bindingVersion", "configHash", "processStartId"]);
  const task = object(root.task, "handoff.task", ["objective", "latestUserInstruction", "acceptanceCriteria"]);
  const workspace = object(root.workspace, "handoff.workspace", ["baseCommit", "headCommit", "fingerprint", "state", "changedFiles"]);
  const workspaceState = enumValue(workspace.state, "handoff.workspace.state", ["clean", "dirty", "unknown"]);
  if (workspaceState !== "unknown" && (workspace.baseCommit === undefined || workspace.fingerprint === undefined || workspace.changedFiles === undefined)) {
    throw new Error("Known workspace state requires baseCommit, fingerprint, and changedFiles facts");
  }
  const normalized: HandoffV1 = {
    schemaVersion: 1,
    taskId: string(root.taskId, "handoff.taskId", 128),
    stageId: string(root.stageId, "handoff.stageId", 128),
    createdAt: isoDate(root.createdAt, "handoff.createdAt"),
    source: {
      attemptId: string(source.attemptId, "handoff.source.attemptId", 128),
      harness: string(source.harness, "handoff.source.harness", 80),
      model: string(source.model, "handoff.source.model", 160),
      ...(source.harnessVersion !== undefined ? { harnessVersion: string(source.harnessVersion, "handoff.source.harnessVersion", 120) } : {}),
      ...(source.bindingVersion !== undefined ? { bindingVersion: string(source.bindingVersion, "handoff.source.bindingVersion", 120) } : {}),
      ...(source.configHash !== undefined ? { configHash: string(source.configHash, "handoff.source.configHash", 256) } : {}),
      ...(source.processStartId !== undefined ? { processStartId: string(source.processStartId, "handoff.source.processStartId", 256) } : {}),
    },
    task: {
      objective: string(task.objective, "handoff.task.objective", 8_000),
      ...(task.latestUserInstruction !== undefined ? { latestUserInstruction: string(task.latestUserInstruction, "handoff.task.latestUserInstruction", 4_000) } : {}),
      acceptanceCriteria: stringArray(task.acceptanceCriteria, "handoff.task.acceptanceCriteria", 20, 1_000),
    },
    workspace: {
      ...(workspace.baseCommit !== undefined ? { baseCommit: string(workspace.baseCommit, "handoff.workspace.baseCommit", 160) } : {}),
      ...(workspace.headCommit !== undefined ? { headCommit: string(workspace.headCommit, "handoff.workspace.headCommit", 160) } : {}),
      ...(workspace.fingerprint !== undefined ? { fingerprint: string(workspace.fingerprint, "handoff.workspace.fingerprint", 256) } : {}),
      state: workspaceState,
      ...(workspace.changedFiles !== undefined ? { changedFiles: stringArray(workspace.changedFiles, "handoff.workspace.changedFiles", 200, 1_024) } : {}),
    },
    completed: stringArray(root.completed, "handoff.completed", 40, 1_000),
    currentState: string(root.currentState, "handoff.currentState", 4_000),
    decisions: objectArray(root.decisions, "handoff.decisions", 30, ["decision", "rationale"], (item, path) => ({
      decision: string(item.decision, `${path}.decision`, 1_000),
      rationale: string(item.rationale, `${path}.rationale`, 1_500),
    })),
    rejectedOptions: objectArray(root.rejectedOptions, "handoff.rejectedOptions", 20, ["option", "reason"], (item, path) => ({
      option: string(item.option, `${path}.option`, 800),
      reason: string(item.reason, `${path}.reason`, 1_200),
    })),
    keyFiles: objectArray(root.keyFiles, "handoff.keyFiles", 100, ["path", "reason"], (item, path) => ({
      path: string(item.path, `${path}.path`, 1_024),
      reason: string(item.reason, `${path}.reason`, 800),
    })),
    checks: objectArray(root.checks, "handoff.checks", 40, ["id", "status", "evidence"], (item, path) => ({
      id: string(item.id, `${path}.id`, 160),
      status: enumValue(item.status, `${path}.status`, ["passed", "failed", "timed_out", "not_run"]),
      ...(item.evidence !== undefined ? { evidence: string(item.evidence, `${path}.evidence`, 1_200) } : {}),
    })),
    blockers: stringArray(root.blockers, "handoff.blockers", 20, 1_000),
    risks: stringArray(root.risks, "handoff.risks", 20, 1_000),
    nextSteps: stringArray(root.nextSteps, "handoff.nextSteps", 20, 1_000),
  };
  const json = JSON.stringify(normalized);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > HANDOFF_V1_MAX_BYTES) throw new Error(`handoff payload exceeds ${HANDOFF_V1_MAX_BYTES} bytes`);
  return normalized;
}

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
  return record;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  if (value.length > max) throw new Error(`${path} exceeds ${max} characters`);
  return value;
}

function stringArray(value: unknown, path: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${path} must be an array with at most ${maxItems} items`);
  return value.map((item, index) => string(item, `${path}[${index}]`, maxLength));
}

function objectArray<T>(
  value: unknown,
  path: string,
  maxItems: number,
  keys: string[],
  parse: (value: Record<string, unknown>, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${path} must be an array with at most ${maxItems} items`);
  return value.map((entry, index) => parse(object(entry, `${path}[${index}]`, keys), `${path}[${index}]`));
}

function enumValue<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${path} must be one of ${values.join(", ")}`);
  return value as T[number];
}

function isoDate(value: unknown, path: string): string {
  const result = string(value, path, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result);
  if (!match || !Number.isFinite(Date.parse(result))) throw new Error(`${path} must be an ISO-8601 date-time with a timezone`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth) throw new Error(`${path} must be an ISO-8601 date-time with a valid calendar date`);
  return result;
}
