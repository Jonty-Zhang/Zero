const MAX_PROJECTION_BYTES = 256 * 1024;
const MAX_STRING_BYTES = 4096;
export const OMITTED_PROTOCOL_STRING = '__ZERO_OVERSIZED_PROTOCOL_STRING__';

/** Compact an oversized JSON line without assuming where its metadata occurs.
 * String contents are bounded, but every byte is scanned for quotes/escapes so
 * fields following a large tool result remain visible. JSON.parse subsequently
 * validates the complete projected structure. This is evidence only, never final text. */
export class ProtocolLineProjection {
  private readonly output = Buffer.alloc(MAX_PROJECTION_BYTES);
  private readonly string = Buffer.alloc(MAX_STRING_BYTES);
  private length = 0;
  private stringLength = 0;
  private inString = false;
  private omitted = false;
  private escape = false;
  private unicode = 0;
  private invalid = false;

  consume(bytes: Buffer): void {
    for (const byte of bytes) {
      if (this.invalid) return;
      if (!this.inString) {
        if (byte === 0x22) { this.inString = true; this.stringLength = 0; this.omitted = false; }
        else this.append(Buffer.from([byte]));
        continue;
      }
      if (!this.escape && this.unicode === 0 && byte === 0x22) {
        this.append(this.omitted ? Buffer.from(JSON.stringify(OMITTED_PROTOCOL_STRING))
          : Buffer.concat([Buffer.from('"'), this.string.subarray(0, this.stringLength), Buffer.from('"')]));
        this.inString = false;
        continue;
      }
      if (this.unicode) {
        if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) this.invalid = true;
        this.unicode--;
      } else if (this.escape) {
        if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74, 0x75].includes(byte)) this.invalid = true;
        if (byte === 0x75) this.unicode = 4;
        this.escape = false;
      } else if (byte === 0x5c) this.escape = true;
      else if (byte < 0x20) this.invalid = true;
      if (!this.omitted) {
        if (this.stringLength === MAX_STRING_BYTES) this.omitted = true;
        else this.string[this.stringLength++] = byte;
      }
    }
  }

  finish(): string {
    if (this.invalid || this.inString || this.escape || this.unicode) throw new Error('Unverifiable oversized protocol line');
    const line = this.output.subarray(0, this.length).toString('utf8');
    JSON.parse(line);
    return line;
  }

  private append(bytes: Buffer): void {
    if (this.length + bytes.length > MAX_PROJECTION_BYTES) { this.invalid = true; return; }
    bytes.copy(this.output, this.length); this.length += bytes.length;
  }
}
