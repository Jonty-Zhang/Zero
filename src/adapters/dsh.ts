import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, parseJsonLines, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, ReasoningEffort, RunContext } from './types.js';

export class DshAdapter extends BaseHarnessAdapter {
  readonly id = 'dsh' as const;

  constructor(config: AdapterConfig = {}) { super(config); }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['--help'], ['--profile', '--json']);
    const matchingBindings = this.bindings
      .filter((binding): binding is Extract<ModelBinding, { harness: 'dsh' }> => binding.harness === 'dsh' && binding.selector === 'profile' && binding.verified);
    const effortSet = new Set<ReasoningEffort>();
    for (const binding of this.bindings) if (binding.harness === 'dsh') for (const effort of binding.reasoningEfforts ?? []) effortSet.add(effort);
    const available = !result.reason;
    const models = this.bindingsForVersion(matchingBindings, result.version).map((binding) => binding.model.id);
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: available ? [...new Set(models)] : [],
      reasoningEfforts: available ? [...effortSet] : [],
      roles: ['implement', 'revise'],
      available,
      probeEvidence: {
        versionAndHelp: available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: available && models.length ? 'declared_verified' : 'none',
        bindingVerification: this.bindingVerification(available ? models : []),
      },
      ...(!available ? { unavailableReason: result.reason } : {}),
    };
  }

  async prepare(context: RunContext, binding: ModelBinding): Promise<Invocation> {
    if (context.role !== 'implement' && context.role !== 'revise') throw new Error('DSH adapter supports implementation and revision runs only');
    if (binding.harness !== 'dsh' || binding.selector !== 'profile' || !binding.verified || !binding.profile.trim()) {
      throw new Error('DSH requires a verified profile model binding');
    }
    if (context.reasoningEffort && !binding.reasoningEfforts?.includes(context.reasoningEffort)) {
      throw new Error(`DSH profile has no verified reasoning effort ${context.reasoningEffort}`);
    }
    const args = ['--profile', binding.profile, '--json', context.prompt];
    assertPromptFitsArgv(args);
    return {
      harness: this.id,
      executable: this.executable,
      args,
      cwd: context.cwd,
      env: {},
      requestedModel: binding.model.modelId,
      reasoningEffort: context.reasoningEffort,
      parseOutput: (stdout, stderr) => this.parseOutput(stdout, stderr),
    };
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
}
