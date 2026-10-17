import { createHash } from "node:crypto";

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}

export function validateSubmissionKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("Invalid idempotency key: expected 16 to 128 ASCII letters, digits, underscores or hyphens");
  }
  return value;
}

/** Stable JSON fingerprint: object key order is immaterial; ordered task arrays are not. */
export function submissionRequestHash(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || !item || ancestors.has(item)) throw new Error("Submission payload must be a finite JSON value");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, element => encode(element)).join(",")}]`;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== null && prototype !== Object.prototype) throw new Error("Submission payload must contain plain JSON objects");
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  };
  return createHash("sha256").update(encode(value), "utf8").digest("hex");
}
