import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLines } from '../base.js';
import { StreamingOutputParser } from '../output-parser.js';

const finalLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'later final' } });

test('oversized tool projection preserves metadata across split JSON escapes and UTF-8', () => {
  const parser = new StreamingOutputParser(parseJsonLines, []);
  parser.consume(Buffer.from('{"type":"item.completed","item":{"type":"command_execution","text":"' + 'x'.repeat(270000)));
  // Each byte is a separate process chunk, including the escaped backslash,
  // escaped quote, four hex digits, and the UTF-8 bytes of the emoji.
  for (const byte of Buffer.from('\\\\\\"\\uD83D\\uDE00😀"},"model":"observed","session_id":"session"}\n')) parser.consume(Buffer.from([byte]));
  parser.consume(finalLine);
  const parsed = parser.finish();
  assert.equal(parsed.actualModel, 'observed');
  assert.equal(parsed.sessionId, 'session');
  assert.equal(parsed.finalText, 'later final');
  assert.equal(parsed.outputError, undefined);
});

test('invalid escapes in discarded tool contents remain fatal after a subsequent valid final', () => {
  const parser = new StreamingOutputParser(parseJsonLines, []);
  parser.consume(Buffer.from('{"type":"item.completed","item":{"type":"command_execution","text":"' + 'x'.repeat(270000)));
  parser.consume(Buffer.from('\\q"}}\n' + finalLine));
  assert.match(parser.finish().outputError ?? '', /protocol|identity/i);
});

test('oversized identity or provider codes cannot become selector-only evidence', () => {
  for (const metadata of [{ model: 'x'.repeat(5000) }, { type: 'turn.failed', error: { code: 'x'.repeat(5000), message: 'Quota exceeded' } }]) {
    const parser = new StreamingOutputParser(parseJsonLines, []);
    parser.consume(Buffer.from(JSON.stringify({ type: 'thread.started', metadata: 'x'.repeat(270000), ...metadata }) + '\n' + finalLine));
    assert.match(parser.finish().outputError ?? '', /metadata/i);
  }
});

test('oversized protocol structure cannot be hidden by a later complete final', () => {
  const parser = new StreamingOutputParser(parseJsonLines, []);
  parser.consume(Buffer.from(JSON.stringify({ type: 'thread.started', fields: Array.from({ length: 100000 }, () => 'small') }) + '\n' + finalLine));
  assert.match(parser.finish().outputError ?? '', /protocol|identity/i);
});
