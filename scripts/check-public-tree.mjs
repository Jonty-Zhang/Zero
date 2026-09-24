import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This catches common accidental disclosures before a public push. It is a
// guardrail, not a replacement for reviewing the exact staged diff and history.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'ls-files', '-z'], { windowsHide: true })
  .toString('utf8').split('\0').filter(Boolean);
const findings = [];
const exampleUsers = new Set(['you', 'user', 'username', 'zero-runner', 'example']);

for (const path of tracked) {
  const normalized = path.replaceAll('\\', '/');
  if (/^(?:data|artifacts|reports)\//i.test(normalized)
    || (/(?:^|\/)\.env(?:\..+)?$/i.test(normalized)
      && normalized !== '.env.example' && !normalized.endsWith('/.env.example'))
    || /(?:^|\/)(?:\.npmrc|\.pypirc)$/i.test(normalized)
    || /\.(?:db|sqlite)(?:-(?:shm|wal))?$/i.test(normalized)
    || /\.(?:log|pem|key)$/i.test(normalized)) {
    findings.push(`${path}: runtime or credential-bearing file is tracked`);
    continue;
  }

  const bytes = readFileSync(resolve(root, path));
  if (bytes.includes(0)) continue;
  const body = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(body)) findings.push(`${path}: private-key marker`);
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(body)) findings.push(`${path}: token-shaped value`);

  for (const match of body.matchAll(/\b[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/gi)) {
    if (!exampleUsers.has(match[1].toLowerCase())) findings.push(`${path}: concrete Windows user-profile path`);
  }
  if (/(?:OPENAI|DEEPSEEK|ANTHROPIC|ZAI|GITHUB)_(?:API_KEY|TOKEN)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/i.test(body)) {
    findings.push(`${path}: credential-looking environment assignment`);
  }
  if (/(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)\s*[:=]\s*['"]?https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(body)) {
    findings.push(`${path}: concrete local proxy setting`);
  }
  for (const match of body.matchAll(/\b(?:https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@([^\s/:]+)/gi)) {
    if (!/\.(?:example|test|invalid)$/i.test(match[1])) findings.push(`${path}: credential-bearing URL`);
  }
}

if (findings.length) {
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public tree check passed (${tracked.length} tracked files).\n`);
}
