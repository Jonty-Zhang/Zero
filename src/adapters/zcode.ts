import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, parseJsonLines, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from './types.js';

export interface ZCodeAdapterConfig extends AdapterConfig {
  /** Absolute JavaScript CLI entry, launched with process.execPath. */
  zcodeEntry?: string;
  /** Private Zero-owned root used only for version/help probes. */
  zcodeProbeDataDir?: string;
}

const SUPPORTED_MODES = new Set(['build', 'yolo']);

export class ZCodeAdapter extends BaseHarnessAdapter {
  readonly id = 'zcode' as const;

  private readonly zcodeEntry?: string;
  private readonly zcodeProbeDataDir: string;
  private readonly launchError?: string;

  constructor(config: ZCodeAdapterConfig = {}) {
    const configuredEntry = nonEmpty(config.zcodeEntry);
    const envEntry = nonEmpty(process.env.ZERO_ZCODE_ENTRY);
    const configuredExecutable = nonEmpty(config.executable);
    const envExecutable = nonEmpty(process.env.ZERO_ZCODE_EXE);
    const entry = configuredEntry ?? envEntry;
    const executable = configuredExecutable ?? envExecutable;
    let launchError: string | undefined;
    if (entry && executable) launchError = 'Choose either ZERO_ZCODE_ENTRY or ZERO_ZCODE_EXE; do not configure both';
    else if (entry && !isJavaScriptEntry(entry)) launchError = 'ZERO_ZCODE_ENTRY must be an absolute .js, .mjs, or .cjs file path';
    else if (!entry && executable && isWindowsScript(executable)) launchError = 'ZCode .cmd/.bat launchers cannot run with shell:false; set ZERO_ZCODE_ENTRY to the absolute JavaScript CLI entry';
    const zcodeExecutable = entry && !launchError ? process.execPath : executable;
    super({ ...config, ...(zcodeExecutable ? { executable: zcodeExecutable } : {}) });
    this.zcodeEntry = entry && !launchError ? entry : undefined;
    this.zcodeProbeDataDir = resolve(config.zcodeProbeDataDir ?? defaultZCodeProbeDataDir());
    this.launchError = launchError;
  }

  async command(args: string[], cwd = process.cwd(), envOverrides: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    if (this.launchError) return { code: null, stdout: '', stderr: '', error: this.launchError };
    await mkdir(this.zcodeProbeDataDir, { recursive: true });
    return super.command(this.withEntry(args), cwd, { ZCODE_DATA_BASE_DIR: this.zcodeProbeDataDir, ...envOverrides });
  }

  async probe(): Promise<HarnessCapabilities> {
    const result = this.launchError
      ? { reason: this.launchError, help: '' }
      : await probeExecutable(this, ['--help'], ['--prompt', '--cwd', '--mode']);
    const bindings = await this.usableBindings(result.version);
    const available = !result.reason;
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: available ? bindings.map((binding) => binding.model.id) : [],
      // The official headless CLI has no documented per-invocation thought-level selector.
      reasoningEfforts: [],
      roles: ['implement', 'revise'],
      available,
      probeEvidence: {
        versionAndHelp: available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: available && bindings.length ? 'declared_verified' : 'none',
        bindingVerification: this.bindingVerification(available ? bindings.map((binding) => binding.model.id) : []),
      },
      ...(!available ? { unavailableReason: result.reason } : {}),
    };
  }

  async prepare(context: RunContext, binding: ModelBinding): Promise<Invocation> {
    if (context.role !== 'implement' && context.role !== 'revise') throw new Error('ZCode adapter supports implementation and revision runs only');
    if (this.launchError) throw new Error(this.launchError);
    if (binding.harness !== 'zcode' || binding.selector !== 'isolated_config' || !binding.verified) {
      throw new Error('ZCode has no confirmed per-call --model selector; a verified isolated_config model binding is required');
    }
    if (!SUPPORTED_MODES.has(binding.mode)) throw new Error('ZCode permission mode must be explicitly configured as build or yolo and verified');
    if (context.reasoningEffort) {
      throw new Error(`ZCode headless CLI cannot enforce the requested reasoning effort ${context.reasoningEffort}`);
    }
    if (binding.reasoningEfforts?.length) {
      throw new Error('ZCode binding declares reasoning efforts, but the headless CLI has no verified effort selector');
    }
    if (!await hasSelectedModel(binding.configDir, binding.model.provider, binding.model.modelId)) {
      throw new Error(`ZCode isolated data directory must contain .zcode/cli/config.json selecting ${binding.model.provider}/${binding.model.modelId}`);
    }
    const args = this.withEntry(['--prompt', context.prompt, '--cwd', context.cwd, '--mode', binding.mode, '--output-format', 'stream-json']);
    assertPromptFitsArgv(args);
    // Official ZCode documents ZCODE_DATA_BASE_DIR as the application data root;
    // CLI data, including its .zcode/cli/config.json, is stored beneath it.
    const env = { ZCODE_DATA_BASE_DIR: binding.configDir };
    return {
      harness: this.id,
      executable: this.executable,
      args,
      cwd: context.cwd,
      env,
      requestedModel: binding.model.modelId,
      reasoningEffort: context.reasoningEffort,
      parseOutput: (stdout, stderr) => this.parseOutput(stdout, stderr),
    };
  }

  private async usableBindings(version?: string): Promise<Extract<ModelBinding, { harness: 'zcode' }>[]> {
    const result: Extract<ModelBinding, { harness: 'zcode' }>[] = [];
    for (const binding of this.bindings) {
      if (binding.harness !== 'zcode' || binding.selector !== 'isolated_config' || !binding.verified) continue;
      // Do not publish a capability whose selected profile cannot be read back,
      // or which claims effort levels that this CLI invocation cannot apply.
      if (binding.reasoningEfforts?.length || !SUPPORTED_MODES.has(binding.mode)) continue;
      if (await hasSelectedModel(binding.configDir, binding.model.provider, binding.model.modelId)
        && binding.mode.trim()
        && (!binding.verifiedCliVersion || binding.verifiedCliVersion === version)) result.push(binding);
    }
    return result;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput {
    const parsed = parseJsonLines(stdout, stderr);
    // ZCode v0.16.9 stream-json closes with { type: "result", response };
    // unlike the event rows, that official summary does not use text/content/final.
    const result = [...parsed.events].reverse().find(event => event.type === 'result')?.data;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return parsed;
    const summary = result as Record<string, unknown>;
    const response = typeof summary.response === 'string' ? summary.response
      : Array.isArray(summary.turnResponses) && typeof summary.turnResponses.at(-1) === 'string' ? summary.turnResponses.at(-1) as string
        : undefined;
    const sessionId = typeof summary.sessionId === 'string' ? summary.sessionId : parsed.sessionId;
    return { ...parsed, ...(response !== undefined ? { finalText: response } : {}), ...(sessionId ? { sessionId } : {}) };
  }

  private withEntry(args: string[]): string[] { return this.zcodeEntry ? [this.zcodeEntry, ...args] : args; }
}

async function hasSelectedModel(dataBaseDir: string, provider: string, modelId: string): Promise<boolean> {
  if (!isAbsolute(dataBaseDir)) return false;
  const configPath = join(dataBaseDir, '.zcode', 'cli', 'config.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const model = (parsed as { model?: unknown }).model;
    if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
    return (model as { main?: unknown }).main === `${provider}/${modelId}`;
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | undefined { return value?.trim() || undefined; }
function isJavaScriptEntry(value: string): boolean { return isAbsolute(value) && ['.js', '.mjs', '.cjs'].includes(extname(value).toLowerCase()); }
function isWindowsScript(value: string): boolean { return /\.(?:cmd|bat)$/i.test(value); }
function defaultZCodeProbeDataDir(): string {
  const root = resolve(process.env.ZERO_DATA_DIR || (process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'), 'Zero')
    : resolve(homedir(), '.local/share/zero')));
  return join(root, 'zcode-probe');
}
