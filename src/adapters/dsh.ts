import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from './types.js';
import { extname, isAbsolute } from 'node:path';
import { runProcess } from './process-runner.js';

export interface DshAdapterConfig extends AdapterConfig {
  /** Zero-owned DSH home used for both CLI probes and task execution. */
  dshHome?: string;
  /** Absolute JavaScript CLI entry, launched with process.execPath. */
  dshEntry?: string;
}

const DSH_PROFILE = 'headless';
const SAFE_PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class DshAdapter extends BaseHarnessAdapter {
  readonly id = 'dsh' as const;
  private readonly dshHome?: string;
  private readonly dshEntry?: string;
  private readonly launchError?: string;

  constructor(config: DshAdapterConfig = {}) {
    const configuredEntry = nonEmpty(config.dshEntry);
    const envEntry = nonEmpty(process.env.ZERO_DSH_ENTRY);
    const configuredExecutable = nonEmpty(config.executable);
    const envExecutable = nonEmpty(process.env.ZERO_DSH_EXE);
    const entry = configuredEntry ?? envEntry;
    const executable = configuredExecutable ?? envExecutable;
    let launchError: string | undefined;
    if (entry && executable) launchError = 'Choose either ZERO_DSH_ENTRY or ZERO_DSH_EXE; do not configure both';
    else if (entry && !isJavaScriptEntry(entry)) launchError = 'ZERO_DSH_ENTRY must be an absolute .js, .mjs, or .cjs file path';
    else if (!entry && executable && isWindowsScript(executable)) launchError = 'DSH .cmd/.bat launchers cannot run with shell:false; set ZERO_DSH_ENTRY to the absolute JavaScript CLI entry';
    const dshExecutable = entry && !launchError ? process.execPath : executable;
    super({ ...config, ...(dshExecutable ? { executable: dshExecutable } : {}) });
    this.dshHome = config.dshHome;
    this.dshEntry = entry && !launchError ? entry : undefined;
    this.launchError = launchError;
  }

  async command(args: string[], cwd = process.cwd()): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    if (this.launchError) return { code: null, stdout: '', stderr: '', error: this.launchError };
    if (!this.dshHome) return { code: null, stdout: '', stderr: '', error: 'DSH_HOME is not configured for Zero' };
    // Config inspection must never inherit provider credentials or user DSH paths.
    const env: NodeJS.ProcessEnv = { DSH_HOME: this.dshHome };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const result = await runProcess({ executable: this.executable, args: this.withEntry(args), cwd, env, timeoutMs: 8_000, maxLogBytes: 256 * 1024 });
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) };
  }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['--profile', DSH_PROFILE, '--help'], [`--profile ${DSH_PROFILE}`, '[task...]']);
    let reason = result.reason;
    const models: string[] = [];
    if (!reason) {
      const bindings = this.bindings.filter((binding): binding is Extract<ModelBinding, { harness: 'dsh' }> =>
        binding.harness === 'dsh' && binding.verified && isSafeProfile(binding.profile) &&
        (!binding.verifiedCliVersion || binding.verifiedCliVersion === result.version));
      for (const binding of bindings) {
        const effective = await this.readEffectiveModel(binding.profile);
        if (effective.error || effective.version !== result.version) continue;
        if (effective.model?.provider === binding.model.provider && effective.model.modelId === binding.model.modelId) models.push(binding.model.id);
      }
    }
    const available = !reason;
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: [...new Set(models)],
      reasoningEfforts: [],
      roles: ['implement', 'revise'],
      available,
      probeEvidence: {
        versionAndHelp: available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: models.length ? 'declared_verified' : 'none',
        bindingVerification: Object.fromEntries([...new Set(models)].map(id => [id, this.bindings.find(binding => binding.harness === this.id && binding.model.id === id)?.verificationSource ?? 'manual_config'])),
      },
      ...(!available ? { unavailableReason: reason } : {}),
    };
  }

  async prepare(context: RunContext, binding: ModelBinding): Promise<Invocation> {
    if (context.role !== 'implement' && context.role !== 'revise') throw new Error('DSH adapter supports implementation and revision runs only');
    if (this.launchError) throw new Error(this.launchError);
    if (!this.dshHome) throw new Error('DSH_HOME must point to a Zero-owned profile directory');
    if (binding.harness !== 'dsh' || binding.selector !== 'profile' || !binding.verified || !isSafeProfile(binding.profile)) {
      throw new Error('DSH requires a verified profile binding with a safe profile name');
    }
    const effective = await this.readEffectiveModel(binding.profile);
    if (effective.error) throw new Error(`Could not verify DSH profile ${binding.profile}: ${effective.error}`);
    if (effective.version && binding.verifiedCliVersion && effective.version !== binding.verifiedCliVersion) {
      throw new Error(`DSH binding was verified for CLI ${binding.verifiedCliVersion}, installed CLI is ${effective.version}`);
    }
    if (effective.model?.provider !== binding.model.provider || effective.model.modelId !== binding.model.modelId) {
      throw new Error(`DSH profile ${binding.profile} selects ${effective.model?.provider ?? 'unknown'}/${effective.model?.modelId ?? 'unknown'}, expected ${binding.model.provider}/${binding.model.modelId}`);
    }
    if (context.reasoningEffort) throw new Error('DSH headless CLI has no verified per-run reasoning-effort selector');

    // DSH 0.1.5-rc.2 accepts task text as positional arguments and prints one
    // final text result. It does not advertise the former --json argument.
    const args = this.withEntry(['--profile', binding.profile, context.prompt]);
    assertPromptFitsArgv(args);
    return {
      harness: this.id,
      executable: this.executable,
      args,
      cwd: context.cwd,
      env: { DSH_HOME: this.dshHome },
      requestedModel: binding.model.modelId,
      parseOutput: (stdout, stderr) => this.parseOutput(stdout, stderr),
    };
  }

  private withEntry(args: string[]): string[] { return this.dshEntry ? [this.dshEntry, ...args] : args; }

  private async readEffectiveModel(profile: string): Promise<{ version?: string; model?: { provider: string; modelId: string }; error?: string }> {
    const versionResult = await this.command(['--version']);
    if (versionResult.code !== 0) return { error: versionResult.error ?? `version probe exited ${String(versionResult.code)}` };
    const version = versionResult.stdout.trim();
    if (!version) return { error: 'version probe returned no version' };
    const dump = await this.command(['--profile', profile, '--dump-config']);
    if (dump.code !== 0) return { version, error: dump.error ?? `profile config dump exited ${String(dump.code)}` };
    const model = parseEffectiveModel(dump.stdout);
    if (!model) return { version, error: 'dump did not contain an unambiguous agent-default-model provider and model' };
    return { version, model };
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return this.parsePlainText(stdout, stderr); }
}

/** Read the final agent-default-model provider/model from DSH's ordered config layers. */
export function parseEffectiveModel(dump: string): { provider: string; modelId: string } | undefined {
  let provider: string | undefined;
  let modelId: string | undefined;
  let disabled = false;
  const lines = dump.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- id:\s*['"]?agent-default-model['"]?\s*$/.test(lines[i] ?? '')) continue;
    let inConfig = false;
    for (i++; i < lines.length && !/^\s*(?:- id:|# ==)/.test(lines[i] ?? ''); i++) {
      const line = lines[i] ?? '';
      if (/^\s{2}config:\s*$/.test(line)) { inConfig = true; continue; }
      if (/^\s{2}disabled:\s*true\s*$/.test(line)) disabled = true;
      if (/^\s{2}\S/.test(line)) inConfig = false;
      if (!inConfig) continue;
      const field = /^\s{4}(provider|model):\s*(\S(?:.*\S)?)\s*$/.exec(line);
      if (!field) continue;
      const value = parseYamlScalar(field[2] ?? '');
      if (value === undefined) return undefined;
      if (field[1] === 'provider') provider = value;
      else modelId = value;
    }
    i--;
  }
  return !disabled && provider && modelId ? { provider, modelId } : undefined;
}

function parseYamlScalar(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; }
    catch { return undefined; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (/^[A-Za-z0-9._/+:-]+$/.test(value)) return value;
  return undefined;
}

function isSafeProfile(profile: string): boolean {
  return profile.toLowerCase() !== 'desktop' && SAFE_PROFILE.test(profile);
}

function nonEmpty(value: string | undefined): string | undefined { return value?.trim() || undefined; }

function isJavaScriptEntry(value: string): boolean {
  return isAbsolute(value) && ['.js', '.mjs', '.cjs'].includes(extname(value).toLowerCase());
}

function isWindowsScript(value: string): boolean { return /\.(?:cmd|bat)$/i.test(value); }
