import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(workspace, 'scripts', 'stage-windows-release.mjs');
const verifier = join(workspace, 'scripts', 'verify-windows-release.mjs');

function withinWorkspace(path) {
  const rel = relative(workspace, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function fakePe(path) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  writeFileSync(path, bytes);
}

test('Windows release staging copies only explicit runtime inputs and hashes every file', () => {
  if (process.platform !== 'win32') return;
  const temp = mkdtempSync(join(workspace, '.zero-release-test-'));
  assert.ok(withinWorkspace(temp));
  try {
    const guardian = join(temp, 'guardian.exe');
    const nodeLicense = join(temp, 'Node-LICENSE');
    const output = join(temp, 'release');
    fakePe(guardian);
    writeFileSync(nodeLicense, 'Fixture license text for the staging test.\n');
    const result = spawnSync(process.execPath, [script, '--node-exe', process.execPath,
      '--node-license', nodeLicense, '--guardian-exe', guardian, '--output-dir', output],
    { cwd: workspace, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '0' }, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.generatedAt, '1970-01-01T00:00:00.000Z');
    const names = manifest.files.map(file => file.path);
    assert.ok(names.includes('runtime/node.exe'));
    assert.ok(names.includes('guardian/guardian.exe'));
    assert.ok(names.includes('dist/cli.js'));
    assert.ok(names.includes('web/dist/index.html'));
    assert.ok(names.includes('licenses/Node-LICENSE.txt'));
    assert.equal(names.some(name => /(?:^|\/)(?:data|\.env|\.git|node_modules)(?:\/|$)/i.test(name)), false);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(output, file.path));
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const verified = spawnSync(process.execPath, [verifier, '--stage-dir', output],
      { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /bundled Zero CLI/);

    const cli = join(output, 'dist', 'cli.js');
    const originalCli = readFileSync(cli);
    writeFileSync(cli, `${originalCli.toString('utf8')}\n// tampered\n`);
    const tampered = spawnSync(process.execPath, [verifier, '--stage-dir', output],
      { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /size mismatch|hash mismatch/);
    writeFileSync(cli, originalCli);

    writeFileSync(join(output, 'unexpected.txt'), 'unlisted');
    const unlisted = spawnSync(process.execPath, [verifier, '--stage-dir', output],
      { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.notEqual(unlisted.status, 0);
    assert.match(unlisted.stderr, /unlisted file/);
    const second = spawnSync(process.execPath, [script, '--node-exe', process.execPath,
      '--node-license', nodeLicense, '--guardian-exe', guardian, '--output-dir', output],
    { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /must be empty/);
  } finally {
    assert.ok(withinWorkspace(temp));
    rmSync(temp, { recursive: true, force: true });
  }
});

test('Windows release staging rejects a malformed guardian before creating output', () => {
  if (process.platform !== 'win32') return;
  const temp = mkdtempSync(join(workspace, '.zero-release-test-'));
  assert.ok(withinWorkspace(temp));
  try {
    const guardian = join(temp, 'invalid.exe');
    const nodeLicense = join(temp, 'Node-LICENSE');
    const output = join(temp, 'release');
    writeFileSync(guardian, 'not PE');
    writeFileSync(nodeLicense, 'Fixture license text.\n');
    const result = spawnSync(process.execPath, [script, '--node-exe', process.execPath,
      '--node-license', nodeLicense, '--guardian-exe', guardian, '--output-dir', output],
    { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a valid Windows PE/);
  } finally {
    assert.ok(withinWorkspace(temp));
    rmSync(temp, { recursive: true, force: true });
  }
});
