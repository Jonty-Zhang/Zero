import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WriteStream } from 'node:fs';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_TRACE_BYTES = 512 * 1024;
const MAX_TRACE_EVENTS = 2_048;
const MAX_ITEM_IDS = 2_048;

const EVENT_TYPES = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
  'item.started', 'item.updated', 'item.completed', 'item.failed', 'item.delta',
]);
const ITEM_TYPES = new Set([
  'agent_message', 'reasoning', 'command_execution', 'file_change',
  'mcp_tool_call', 'web_search', 'plan_update',
]);
const STATUSES = new Set(['in_progress', 'completed', 'failed', 'cancelled', 'pending']);

interface TraceRecord {
  at: string;
  eventType: string;
  itemType: string;
  itemId: string | null;
  status: string;
}

/** Writes a bounded projection of Codex JSONL events; source JSON is never retained. */
export class CodexLifecycleTrace {
  private readonly itemIds = new Map<string, string>();
  private readonly lineParts: Buffer[] = [];
  private lineBytes = 0;
  private discardingLine = false;
  private writtenBytes = 0;
  private eventCount = 0;
  private disabled = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly stream: WriteStream) {
    stream.on('error', () => { this.disabled = true; });
  }

  static async open(path: string): Promise<CodexLifecycleTrace | undefined> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const stream = createWriteStream(path, { flags: 'wx' });
      const trace = new CodexLifecycleTrace(stream);
      await new Promise<void>((resolve) => {
        stream.once('open', () => resolve());
        stream.once('error', () => resolve());
      });
      return trace;
    } catch {
      // Diagnostics must never prevent or fail the actual harness run.
      return undefined;
    }
  }

  consume(chunk: Buffer | string): void {
    if (this.disabled || this.closePromise) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.disabled) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);

      if (!this.discardingLine) {
        if (this.lineBytes + part.length > MAX_LINE_BYTES) {
          this.lineParts.length = 0;
          this.lineBytes = 0;
          this.discardingLine = true;
          this.writeRecord({ eventType: 'invalid', itemType: 'unknown', itemId: null, status: 'oversize' });
        } else if (part.length > 0) {
          this.lineParts.push(part);
          this.lineBytes += part.length;
        }
      }

      if (newline < 0) return;
      if (this.discardingLine) {
        this.discardingLine = false;
      } else {
        this.parseLine(Buffer.concat(this.lineParts, this.lineBytes));
      }
      this.lineParts.length = 0;
      this.lineBytes = 0;
      offset = newline + 1;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.discardingLine && this.lineBytes > 0 && !this.disabled) {
        this.parseLine(Buffer.concat(this.lineParts, this.lineBytes));
      }
      this.lineParts.length = 0;
      this.lineBytes = 0;
      if (this.stream.destroyed || this.stream.closed) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => resolve();
        this.stream.once('finish', finish);
        this.stream.once('close', finish);
        this.stream.once('error', finish);
        this.stream.end();
      });
    })();
    return this.closePromise;
  }

  private parseLine(line: Buffer): void {
    const text = line.toString('utf8').trim();
    if (!text || this.disabled) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { this.writeRecord({ eventType: 'invalid', itemType: 'unknown', itemId: null, status: 'malformed' }); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.writeRecord({ eventType: 'invalid', itemType: 'unknown', itemId: null, status: 'malformed' });
      return;
    }

    const event = parsed as Record<string, unknown>;
    const eventType = typeof event.type === 'string' && EVENT_TYPES.has(event.type) ? event.type : 'other';
    const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
      ? event.item as Record<string, unknown> : undefined;
    const rawItemType = item && typeof item.type === 'string' ? item.type : undefined;
    const itemType = rawItemType && ITEM_TYPES.has(rawItemType) ? rawItemType : rawItemType ? 'other' : 'unknown';
    const rawId = item && typeof item.id === 'string' && item.id.length <= 128 ? item.id : undefined;
    const itemId = rawId ? this.opaqueItemId(rawId) : null;
    const rawStatus = item && typeof item.status === 'string' ? item.status : undefined;
    const status = rawStatus && STATUSES.has(rawStatus)
      ? rawStatus
      : eventType === 'turn.completed' || eventType === 'item.completed' ? 'completed'
        : eventType === 'turn.failed' || eventType === 'item.failed' || eventType === 'error' ? 'failed' : 'unknown';
    this.writeRecord({ eventType, itemType, itemId, status });
  }

  private opaqueItemId(rawId: string): string | null {
    const existing = this.itemIds.get(rawId);
    if (existing) return existing;
    if (this.itemIds.size >= MAX_ITEM_IDS) return null;
    const opaqueId = `i${this.itemIds.size + 1}`;
    this.itemIds.set(rawId, opaqueId);
    return opaqueId;
  }

  private writeRecord(record: Omit<TraceRecord, 'at'>): void {
    if (this.disabled) return;
    if (this.eventCount >= MAX_TRACE_EVENTS || this.writtenBytes >= MAX_TRACE_BYTES) {
      this.disabled = true;
      return;
    }
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.writtenBytes + bytes > MAX_TRACE_BYTES) {
      this.disabled = true;
      return;
    }
    try {
      this.stream.write(line);
      this.writtenBytes += bytes;
      this.eventCount++;
    } catch {
      this.disabled = true;
    }
  }
}
