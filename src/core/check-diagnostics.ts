import { StringDecoder } from 'node:string_decoder';
import type { CheckResult, CheckStreamDiagnostic } from '../domain/types.js';

const STREAM_BYTES = 4096;
const JSON_BYTES = 65536;
const GAP = '\n[...output omitted...]\n';

function prefix(bytes: Buffer, limit: number): string {
  // write() leaves a partial terminal code point buffered instead of inventing U+FFFD.
  return new StringDecoder('utf8').write(bytes.subarray(0, limit));
}

function suffix(bytes: Buffer, limit: number): string {
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/** Constant retained space even for checks that produce unlimited output. */
export class DiagnosticCapture {
  readonly #decoder = new StringDecoder('utf8');
  #head: Buffer = Buffer.alloc(0);
  #tail: Buffer = Buffer.alloc(0);
  #size = 0;

  write(chunk: Buffer): void { this.#append(this.#decoder.write(chunk)); }

  #append(text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    this.#size += bytes.length;
    if (this.#head.length < STREAM_BYTES) this.#head = Buffer.concat([this.#head, bytes.subarray(0, STREAM_BYTES - this.#head.length)]);
    this.#tail = bytes.length >= STREAM_BYTES / 2 ? Buffer.from(bytes.subarray(-STREAM_BYTES / 2))
      : Buffer.concat([this.#tail, bytes]).subarray(-STREAM_BYTES / 2);
  }

  snapshot(): CheckStreamDiagnostic {
    this.#append(this.#decoder.end());
    if (this.#size <= STREAM_BYTES) return { text: this.#head.toString('utf8'), truncated: false };
    return { text: prefix(this.#head, STREAM_BYTES / 2) + GAP
      + suffix(this.#tail, STREAM_BYTES / 2 - Buffer.byteLength(GAP)), truncated: true };
  }
}

/** No filesystem access: historical paths are metadata, never read authority. */
export function projectCheckDiagnostics(checks: CheckResult[]): string {
  const projection = { untrusted: true, omittedChecks: checks.length, checks: [] as object[] };
  const stream = (observed: CheckStreamDiagnostic) => {
    const capture = new DiagnosticCapture();
    capture.write(Buffer.from(observed.text, 'utf8'));
    const bounded = capture.snapshot();
    return { text: bounded.text, truncated: observed.truncated || bounded.truncated, omitted: bounded.truncated };
  };
  for (const [index, check] of checks.entries()) {
    const entry = check.diagnostics
      ? { index, unavailable: false, omitted: false, stdout: stream(check.diagnostics.stdout), stderr: stream(check.diagnostics.stderr) }
      : { index, unavailable: true, omitted: false };
    projection.checks.push(entry);
    projection.omittedChecks--;
    if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > JSON_BYTES) {
      projection.checks.pop();
      projection.omittedChecks++;
      break;
    }
  }
  return JSON.stringify(projection);
}
