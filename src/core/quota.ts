/** Narrow classifier for provider quota/rate-limit responses. Authentication, network, and generic CLI errors stay ordinary failures. */
export interface QuotaSignal { retryAt?: string; source: "provider_message" | "retry_after" | "fallback" }

const QUOTA_PATTERNS = [
  /you(?:'ve| have) hit your usage limit/i,
  /usage limit (?:has been )?(?:reached|exceeded)/i,
  /quota (?:has been )?(?:exceeded|reached)/i,
];

export function classifyQuota(text: string, now = Date.now()): QuotaSignal | undefined {
  // Billing and authorization failures require account action; sleeping cannot restore them.
  if (/insufficient_quota|credit_balance_exhausted|organization_spend_limit_exceeded|billing_hard_limit_reached|payment required/i.test(text)) return undefined;
  if (!QUOTA_PATTERNS.some(pattern => pattern.test(text))) return undefined;
  const retryAfter = text.match(/retry-after\s*[:=]\s*(\d{1,9})/i);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    if (seconds > 0) return { source: "retry_after", retryAt: new Date(now + Math.min(seconds, 30 * 24 * 60 * 60) * 1000).toISOString() };
  }
  const timestamp = text.match(/(?:reset(?:s)?(?:\s+at)?|try again(?:\s+at)?|available(?:\s+at)?)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (timestamp) {
    const value = timestamp[1]!.replace(" ", "T");
    const date = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
    if (Number.isFinite(date) && date > now && date <= now + 30 * 24 * 60 * 60 * 1000) return { source: "provider_message", retryAt: new Date(date).toISOString() };
  }
  // Some Codex messages say "try again in 5h 20m" instead of giving a timestamp.
  const duration = text.match(/(?:try again|resets?)(?:\s+in)?\s+(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i);
  if (duration && (duration[1] || duration[2] || duration[3])) {
    const ms = Number(duration[1] ?? 0) * 3_600_000 + Number(duration[2] ?? 0) * 60_000 + Number(duration[3] ?? 0) * 1000;
    if (ms > 0 && ms <= 30 * 24 * 60 * 60_000) return { source: "provider_message", retryAt: new Date(now + ms).toISOString() };
  }
  return { source: "fallback" };
}

export class QuotaLimitError extends Error {
  readonly quota = true;
  constructor(message: string, readonly retryAt?: string) { super(message); this.name = "QuotaLimitError"; }
}

/** Exponential recheck, capped at six hours, so long windows keep rechecking without a busy loop. */
export function quotaRetryAt(retryCount: number, signal: QuotaSignal | undefined, now = Date.now()): string {
  const suggested = signal?.retryAt ? Date.parse(signal.retryAt) : Number.NaN;
  if (Number.isFinite(suggested) && suggested > now + 5_000) return new Date(suggested).toISOString();
  if (Number.isFinite(suggested) && suggested > now) return new Date(now + 30_000).toISOString();
  const delay = Math.min(5 * 60_000 * 2 ** Math.max(0, retryCount - 1), 6 * 60 * 60_000);
  return new Date(now + delay).toISOString();
}
