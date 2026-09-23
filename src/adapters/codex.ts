import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, parseJsonLines } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from './types.js';

export class CodexAdapter extends BaseHarnessAdapter {
  readonly id = 'codex' as const;

  constructor(config: AdapterConfig = {}) { super(config); }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['exec', '--help'], ['--json', '--model', '--sandbox', '--cd', '--output-schema', '-c', '--ignore-user-config', '--ephemeral']);
    const available = !result.reason;
    const models = this.bindingsForVersion(this.bindings.filter((binding) => binding.harness === 'codex'), result.version).map((binding) => binding.model.id);
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      models: available ? models : [],
      reasoningEfforts: available ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : [],
      roles: ['implement', 'revise', 'review', 'route'],
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
    if (binding.harness !== 'codex' || binding.selector !== 'cli_argument' || !binding.verified) {
      throw new Error('Codex requires a verified cli_argument model binding');
    }
    const args = ['exec', '--json', '--model', binding.model.modelId, '--sandbox', context.role === 'review' || context.role === 'allocate' ? 'read-only' : 'workspace-write', '--cd', context.cwd];
    if (context.role === 'review' || context.role === 'allocate') args.push('--ignore-user-config', '--ephemeral');
    if (context.reasoningEffort) {
      const supported = binding.reasoningEfforts ?? ['minimal', 'low', 'medium', 'high', 'xhigh'];
      if (!supported.includes(context.reasoningEffort)) throw new Error(`Codex model binding does not support reasoning effort ${context.reasoningEffort}`);
      args.push('-c', `model_reasoning_effort=${context.reasoningEffort}`);
    }
    if (context.outputSchemaPath) args.push('--output-schema', context.outputSchemaPath);
    args.push('-');
    return {
      harness: this.id,
      executable: this.executable,
      args,
      stdin: context.prompt,
      cwd: context.cwd,
      env: {},
      requestedModel: binding.model.modelId,
      reasoningEffort: context.reasoningEffort,
      parseOutput: (stdout, stderr) => this.parseOutput(stdout, stderr),
    };
  }

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return parseJsonLines(stdout, stderr); }
}
