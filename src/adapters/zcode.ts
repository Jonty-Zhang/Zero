import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, parseJsonLines, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, ReasoningEffort, RunContext } from './types.js';

export class ZCodeAdapter extends BaseHarnessAdapter {
  readonly id = 'zcode' as const;

  constructor(config: AdapterConfig = {}) { super(config); }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['--help'], ['--prompt', '--cwd', '--mode', '--output-format', 'stream-json']);
    const bindings = await this.usableBindings(result.version);
    const effortSet = new Set<ReasoningEffort>();
    for (const binding of bindings) for (const effort of binding.reasoningEfforts ?? []) effortSet.add(effort);
    const available = !result.reason;
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: available ? bindings.map((binding) => binding.model.id) : [],
      reasoningEfforts: available ? [...effortSet] : [],
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
    if (binding.harness !== 'zcode' || binding.selector !== 'isolated_config' || !binding.verified) {
      throw new Error('ZCode has no confirmed per-call --model selector; a verified isolated_config model binding is required');
    }
    if (!binding.mode.trim()) throw new Error('ZCode permission mode must be explicitly configured and verified');
    if (context.reasoningEffort && !binding.reasoningEfforts?.includes(context.reasoningEffort)) {
      throw new Error(`ZCode config has no verified reasoning effort ${context.reasoningEffort}`);
    }
    if (!await directoryExists(binding.configDir)) throw new Error(`ZCode isolated model config directory does not exist: ${binding.configDir}`);
    const args = ['--prompt', context.prompt, '--cwd', context.cwd, '--mode', binding.mode, '--output-format', 'stream-json'];
    assertPromptFitsArgv(args);
    const env = process.platform === 'win32' ? { APPDATA: binding.configDir } : { XDG_CONFIG_HOME: binding.configDir };
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
      if (await directoryExists(binding.configDir) && binding.mode.trim() && (!binding.verifiedCliVersion || binding.verifiedCliVersion === version)) result.push(binding);
    }
    return result;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
}

async function directoryExists(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}
