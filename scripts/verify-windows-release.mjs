import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function fail(message) { throw new Error(message); }

const args = process.argv.slice(2);

function plainFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} must be a plain file.`);
  return info;
}

function collect(directory, prefix = '') {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`Release contains a link/reparse point: ${prefix}${name}`);
    const rel = `${prefix}${name}`;
    if (info.isDirectory()) result.push(...collect(path, `${rel}/`));
    else if (info.isFile()) result.push(rel);
    else fail(`Release contains an unsupported filesystem entry: ${rel}`);
  }
  return result;
}

try {
  if (args.length !== 2 || args[0] !== '--stage-dir' || !isAbsolute(args[1])) {
    fail('Usage: node verify-windows-release.mjs --stage-dir <absolute-release-directory>');
  }
  const stage = resolve(args[1]);
  const stageInfo = lstatSync(stage);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || stageInfo.isReparsePoint?.()) fail('Release directory must be a plain directory.');
  const manifestPath = join(stage, 'manifest.json');
  if (!existsSync(manifestPath) || plainFile(manifestPath, 'Manifest').size > 1024 * 1024) fail('Release manifest is missing or too large.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== 1 || manifest.product !== 'Zero' || !Array.isArray(manifest.files) || !manifest.files.length) {
    fail('Unsupported release manifest.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion)) fail('Invalid manifest Node version.');
  const listed = new Set();
  for (const entry of manifest.files) {
    const name = entry?.path;
    if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') ||
        name.startsWith('/') || name.includes(':') || name === 'manifest.json' || listed.has(name)) fail('Invalid or duplicate manifest path.');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail(`Invalid manifest metadata: ${name}`);
    const path = join(stage, ...name.split('/'));
    const rel = relative(stage, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`Manifest path leaves release directory: ${name}`);
    const info = plainFile(path, name);
    if (info.size !== entry.size) fail(`Release size mismatch: ${name}`);
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash !== entry.sha256) fail(`Release hash mismatch: ${name}`);
    listed.add(name);
  }
  for (const required of ['runtime/node.exe', 'guardian/guardian.exe', 'dist/cli.js', 'web/dist/index.html',
    'licenses/Node-LICENSE.txt', 'licenses/Zero-LICENSE.txt', 'scripts/run-zero.ps1',
    'scripts/start-zero.ps1', 'scripts/uninstall-windows-task.ps1']) {
    if (!listed.has(required)) fail(`Release is missing required file: ${required}`);
  }
  const actual = collect(stage).filter(name => name !== 'manifest.json');
  if (actual.length !== listed.size || actual.some(name => !listed.has(name))) fail('Release contains an unlisted file.');
  const node = join(stage, 'runtime', 'node.exe');
  const version = spawnSync(node, ['--version'], { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (version.error || version.status !== 0 || version.stdout.trim() !== `v${manifest.nodeVersion}`) fail('Bundled Node version does not match manifest.');
  const smoke = spawnSync(node, [join(stage, 'dist', 'cli.js'), 'help'],
    { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (smoke.error || smoke.status !== 0 || !smoke.stdout.includes('Zero task node')) fail('Bundled Zero CLI smoke test failed.');
  process.stdout.write(`Verified ${listed.size} release files and bundled Zero CLI.\n`);
} catch (error) {
  process.stderr.write(`Windows release verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
