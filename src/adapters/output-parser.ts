import type { ParsedOutput } from './types.js';

const MAX_PROTOCOL_LINE_BYTES = 256 * 1024;
const MAX_PROVIDER_ERRORS = 16;
const MAX_ERROR_CHARACTERS = 4_096;

/** Bounded protocol state independent of the bounded diagnostic log prefix.
 * Buffers end at newline boundaries, so UTF-8 code points and escaped JSON strings
 * may span any number of process chunks. Raw bytes never leave this observer. */
export class StreamingOutputParser {
  private parts: Buffer[] = [];
  private bytes = 0;
  private discarding = false;
  private skippedLine = false;
  private finalText?: string;
  private actualModel?: string;
  private sessionId?: string;
  private modelConflict = false;
  private structured = false;
  private readonly providerErrors: string[] = [];
  private parseFailure?: string;

  constructor(private readonly parse: (stdout: string, stderr: string) => ParsedOutput, private readonly secrets: string[]) {}

  consume(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      if (!this.discarding) {
        if (this.bytes + part.length > MAX_PROTOCOL_LINE_BYTES) {
          this.parts = []; this.bytes = 0; this.discarding = true;
          this.skippedLine = true;
          // We cannot establish whether an oversized event supersedes an earlier
          // final. A subsequent valid final must establish the relay again.
          this.finalText = undefined;
        } else if (part.length) { this.parts.push(part); this.bytes += part.length; }
      }
      if (newline < 0) return;
      if (!this.discarding) this.parseLine();
      this.parts = []; this.bytes = 0; this.discarding = false;
      offset = newline + 1;
    }
  }

  finish(): Omit<ParsedOutput, 'events'> {
    if (!this.discarding && this.bytes) this.parseLine();
    this.parts = []; this.bytes = 0;
    const outputError = this.parseFailure ?? (this.skippedLine && this.finalText === undefined
      ? 'Protocol output line exceeded the bounded parsing limit; no subsequent complete final message was available'
      : undefined);
    return {
      finalText: this.finalText, actualModel: this.actualModel, sessionId: this.sessionId,
      ...(this.modelConflict ? { modelConflict: true } : {}),
      ...(this.structured ? { hasStructuredOutput: true } : {}),
      ...(this.providerErrors.length ? { providerErrors: [...this.providerErrors] } : {}),
      ...(outputError ? { outputError } : {}),
    };
  }

  private parseLine(): void {
    const line = Buffer.concat(this.parts, this.bytes).toString('utf8');
    if (!line.trim()) return;
    let parsed: ParsedOutput;
    try { parsed = this.parse(line, ''); }
    catch { this.parseFailure = 'Harness protocol output could not be parsed'; return; }
    if (parsed.finalText !== undefined) this.finalText = redactText(parsed.finalText, this.secrets);
    if (parsed.actualModel) {
      if (this.actualModel && this.actualModel !== parsed.actualModel) this.modelConflict = true;
      this.actualModel ??= redactText(parsed.actualModel, this.secrets);
    }
    this.modelConflict ||= Boolean(parsed.modelConflict);
    this.sessionId ??= parsed.sessionId ? redactText(parsed.sessionId, this.secrets) : undefined;
    this.structured ||= Boolean(parsed.hasStructuredOutput);
    for (const error of parsed.providerErrors ?? []) {
      if (this.providerErrors.length >= MAX_PROVIDER_ERRORS) break;
      this.providerErrors.push(redactText(error, this.secrets).slice(0, MAX_ERROR_CHARACTERS));
    }
  }
}

export function redactText(text: string, secrets: string[]): string {
  for (const secret of new Set(secrets.filter(Boolean))) text = text.split(secret).join('[REDACTED]');
  return text;
}

/** Plaintext fallback is only for CLIs without structured events. Anchoring keeps
 * quoted agent/tool log lines from being interpreted as provider diagnostics. */
export function plaintextProviderError(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  const provider = /^(?:(?:error|codex|dsh|zcode)(?:\s+error)?\s*:\s*)?(?:you(?:'ve| have) hit your usage limit\b|usage limit (?:has been )?(?:reached|exceeded)\b|quota (?:has been )?(?:exceeded|reached)\b)/i;
  return lines.filter(line => provider.test(line.trim()) || /^\s*(?:retry-after|resets?(?:\s+at)?|try again(?:\s+at|\s+in)?)\s*[:=]?\s*(?:\d|\d{4}-)/i.test(line)).join('\n');
}
