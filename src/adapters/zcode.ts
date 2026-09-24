import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, parseJsonLines, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from './types.js';

export class ZCodeAdapter extends BaseHarnessAdapter {
  readonly id = 'zcode' as const;

  constructor(config: AdapterConfig = {}) { super(config); }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['--help'], ['--prompt', '--cwd', '--mode', '--output-format', 'stream-json']);
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
    if (binding.harness !== 'zcode' || binding.selector !== 'isolated_config' || !binding.verified) {
      throw new Error('ZCode has no confirmed per-call --model selector; a verified isolated_config model binding is required');
    }
    if (!binding.mode.trim()) throw new Error('ZCode permission mode must be explicitly configured and verified');
    if (context.reasoningEffort) {
      throw new Error(`ZCode headless CLI cannot enforce the requested reasoning effort ${context.reasoningEffort}`);
    }
    if (binding.reasoningEfforts?.length) {
      throw new Error('ZCode binding declares reasoning efforts, but the headless CLI has no verified effort selector');
    }
    if (!await hasSelectedModel(binding.configDir, binding.model.provider, binding.model.modelId)) {
      throw new Error(`ZCode isolated data directory must contain .zcode/cli/config.json selecting ${binding.model.provider}/${binding.model.modelId}`);
    }
    const args = ['--prompt', context.prompt, '--cwd', context.cwd, '--mode', binding.mode, '--output-format', 'stream-json'];
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
      if (binding.reasoningEfforts?.length) continue;
      if (await hasSelectedModel(binding.configDir, binding.model.provider, binding.model.modelId)
        && binding.mode.trim()
        && (!binding.verifiedCliVersion || binding.verifiedCliVersion === version)) result.push(binding);
    }
    return result;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
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
