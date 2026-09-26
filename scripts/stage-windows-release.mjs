import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootReal = realpathSync(root);
const forbiddenName = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|data|logs?|reports?|artifacts|\.git|\.codex|\.zero|node_modules)$/i;
const forbiddenExtension = /\.(?:db|sqlite|log|pem|key)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /(?:OPENAI|DEEPSEEK|ANTHROPIC|ZAI|GITHUB)_(?:API_KEY|TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
  /(?:https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@/i,
];

function fail(message) { throw new Error(message); }
function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--node-exe', '--node-license', '--guardian-exe', '--output-dir'].includes(key) || args[key]) fail(`Unknown or duplicate argument: ${key}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Missing value for ${key}`);
    args[key] = argv[++i];
  }
  for (const key of ['--node-exe', '--guardian-exe', '--output-dir']) if (!args[key]) fail(`Required argument: ${key}`);
  return args;
}
function checkNoLinkPath(path, label) {
  const abs = resolve(path);
  const parsedRoot = parse(abs).root;
  const parts = abs.slice(parsedRoot.length).split(/[\\/]/).filter(Boolean);
  let cursor = parsedRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} contains a symlink or reparse point: ${cursor}`);
  }
  return abs;
}
function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isTestArtifact(name) { return name === '__tests__' || /\.test\.js$/i.test(name); }
function validateSourceTree(source, label, runtimeOnly = false) {
  const info = lstatSync(source);
  if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} may not be a symlink/reparse point.`);
  if (info.isDirectory()) {
    for (const name of readdirSync(source)) {
      if (runtimeOnly && isTestArtifact(name)) continue;
      if (forbiddenName.test(name) || forbiddenExtension.test(name)) fail(`Disallowed runtime data path in ${label}: ${name}`);
      validateSourceTree(join(source, name), label, runtimeOnly);
    }
  } else if (!info.isFile()) fail(`Unsupported filesystem entry in ${label}: ${source}`);
}
function verifyText(path, rel) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return;
  const body = bytes.toString('utf8');
  if (secretPatterns.some((pattern) => pattern.test(body))) fail(`Credential/private-key pattern found in ${rel}`);
  if (/(?:^|\/)\.env(?:\..+)?$/i.test(rel) || forbiddenName.test(basename(rel)) || forbiddenExtension.test(extname(rel))) {
    fail(`Disallowed runtime data file in bundle: ${rel}`);
  }
}
function filesUnder(source, destination, fileList, runtimeOnly = false) {
  for (const name of readdirSync(source).sort()) {
    if (runtimeOnly && isTestArtifact(name)) continue;
    const from = join(source, name);
    const to = join(destination, name);
    const info = lstatSync(from);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`Refusing symlink/reparse point: ${from}`);
    if (info.isDirectory()) {
      mkdirSync(to, { recursive: true });
      filesUnder(from, to, fileList, runtimeOnly);
    } else if (info.isFile()) {
      verifyText(from, relative(root, from).replaceAll('\\', '/'));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      fileList.push(to);
    } else fail(`Unsupported filesystem entry: ${from}`);
  }
}
function validPe(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 256 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const peOffset = bytes.readUInt32LE(0x3c);
  return peOffset + 4 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).toString('ascii') === 'PE\0\0';
}

try {
  const args = argsOf(process.argv.slice(2));
  const nodeExe = args['--node-exe'];
  const guardianExe = args['--guardian-exe'];
  const outputDir = args['--output-dir'];
  const nodeLicense = args['--node-license'] ?? join(dirname(nodeExe), 'LICENSE');
  for (const [path, label] of [[nodeExe, 'Node executable'], [guardianExe, 'Guardian executable'], [outputDir, 'Output directory']]) {
    if (!isAbsolute(path)) fail(`${label} must be an absolute path.`);
  }
  if (!isAbsolute(nodeLicense)) fail('Node license must be an absolute path.');
  checkNoLinkPath(nodeExe, 'Node executable path');
  checkNoLinkPath(guardianExe, 'Guardian executable path');
  checkNoLinkPath(nodeLicense, 'Node license path');
  if (!statSync(nodeExe).isFile() || !statSync(guardianExe).isFile()) fail('Node and guardian inputs must be files.');
  if (!validPe(nodeExe)) fail('Node input is not a valid Windows PE executable.');
  if (!validPe(guardianExe)) fail('Guardian input is not a valid Windows PE executable.');
  const version = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) fail('Could not run the supplied Node executable.');
  const versionMatch = version.stdout.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!versionMatch || Number(versionMatch[1]) < 24) fail(`Node.js 24 or later is required; got ${version.stdout.trim() || version.stderr.trim()}.`);

  if (!existsSync(nodeLicense) || !lstatSync(nodeLicense).isFile() || lstatSync(nodeLicense).isSymbolicLink()) {
    fail('Expected the official Node distribution LICENSE at --node-license or beside node.exe.');
  }
  const required = [join(root, 'dist', 'cli.js'), join(root, 'web', 'dist', 'index.html')];
  for (const path of required) if (!existsSync(path) || !lstatSync(path).isFile()) fail(`Required build output is missing: ${relative(root, path)}`);
  validateSourceTree(join(root, 'dist'), 'dist', true);
  validateSourceTree(join(root, 'web', 'dist'), 'web/dist');

  const outAbs = checkNoLinkPath(outputDir, 'Output path');
  const outParent = realpathSync(dirname(outAbs));
  if (!isWithin(rootReal, outParent) || !isWithin(rootReal, outAbs)) fail('Output directory must be inside the Zero workspace.');
  if ([join(rootReal, 'dist'), join(rootReal, 'web', 'dist'), join(rootReal, 'scripts')].some(source => isWithin(source, outAbs))) {
    fail('Output directory may not be inside runtime source directories.');
  }
  if (existsSync(outAbs)) {
    const existing = lstatSync(outAbs);
    if (existing.isSymbolicLink() || existing.isReparsePoint?.() || !existing.isDirectory()) fail('Output path must be a plain directory.');
    if (readdirSync(outAbs).length !== 0) fail('Output directory must be empty; staging never overwrites an existing release.');
  }

  const stage = mkdtempSync(join(outParent, '.zero-stage-'));
  try {
    const files = [];
    const copyOne = (from, rel) => {
      verifyText(from, rel);
      const to = join(stage, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      files.push(to);
    };
    copyOne(nodeExe, 'runtime/node.exe');
    copyOne(nodeLicense, 'licenses/Node-LICENSE.txt');
    copyOne(guardianExe, 'guardian/guardian.exe');
    copyOne(join(root, 'LICENSE'), 'licenses/Zero-LICENSE.txt');
    copyOne(join(root, 'package.json'), 'package.json');
    filesUnder(join(root, 'dist'), join(stage, 'dist'), files, true);
    filesUnder(join(root, 'web', 'dist'), join(stage, 'web', 'dist'), files);
    for (const script of ['run-zero.ps1', 'start-zero.ps1', 'uninstall-windows-task.ps1']) {
      copyOne(join(root, 'scripts', script), `scripts/${script}`);
    }
    const manifestEntries = files.map((path) => {
      const data = readFileSync(path);
      return { path: relative(stage, path).replaceAll('\\', '/'), size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const sourceEpoch = process.env.SOURCE_DATE_EPOCH;
    const epochSeconds = sourceEpoch === undefined ? Math.floor(Date.now() / 1000) : Number(sourceEpoch);
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0 || epochSeconds > 253402300799) fail('SOURCE_DATE_EPOCH must be a supported non-negative Unix timestamp.');
    const manifest = {
      format: 1,
      product: 'Zero',
      nodeVersion: version.stdout.trim().replace(/^v/, ''),
      generatedAt: new Date(epochSeconds * 1000).toISOString(),
      files: manifestEntries,
    };
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    if (existsSync(outAbs) && readdirSync(outAbs).length === 0) rmSync(outAbs, { recursive: true });
    renameSync(stage, outAbs);
    process.stdout.write(`Staged Zero runtime (${manifestEntries.length} files, Node ${manifest.nodeVersion}) at ${outAbs}\n`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
} catch (error) {
  process.stderr.write(`Windows release staging failed: ${error.message}\n`);
  process.exitCode = 1;
}
