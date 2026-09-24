import type { HarnessCapabilities } from '../domain/types.js';
import { BaseHarnessAdapter, probeExecutable, assertPromptFitsArgv } from './base.js';
import type { AdapterConfig } from './base.js';
import type { Invocation, ModelBinding, ParsedOutput, RunContext } from './types.js';

export interface DshAdapterConfig extends AdapterConfig {
  /** Zero-owned DSH home used for both CLI probes and task execution. */
  dshHome?: string;
}

const DSH_PROFILE = 'headless';
const SAFE_PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class DshAdapter extends BaseHarnessAdapter {
  readonly id = 'dsh' as const;
  private readonly dshHome?: string;

  constructor(config: DshAdapterConfig = {}) {
    const executable = config.executable ?? process.env.ZERO_DSH_EXE?.trim();
    super({ ...config, ...(executable ? { executable } : {}) });
    this.dshHome = config.dshHome;
  }

  async command(args: string[], cwd = process.cwd()): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    if (!this.dshHome) return { code: null, stdout: '', stderr: '', error: 'DSH_HOME is not configured for Zero' };
    return super.command(args, cwd, { DSH_HOME: this.dshHome });
  }

  async probe(): Promise<HarnessCapabilities> {
    const result = await probeExecutable(this, ['--profile', DSH_PROFILE, '--help'], [`--profile ${DSH_PROFILE}`, '[task...]']);
    const available = !result.reason;
    return {
      harness: this.id,
      ...(result.version ? { version: result.version } : {}),
      // The CLI probe proves only that the headless entry point exists. DSH's
      // effective profile config is not yet verified against a Zero binding.
      models: [],
      reasoningEfforts: [],
      roles: ['implement', 'revise'],
      available,
      probeEvidence: {
        versionAndHelp: available ? 'passed' : 'failed',
        authentication: 'not_checked',
        modelSmokeTest: 'not_checked',
        configuredBindings: 'none',
        bindingVerification: {},
      },
      ...(!available ? { unavailableReason: result.reason } : {}),
    };
  }

  async prepare(context: RunContext, binding: ModelBinding): Promise<Invocation> {
    if (context.role !== 'implement' && context.role !== 'revise') throw new Error('DSH adapter supports implementation and revision runs only');
    if (!this.dshHome) throw new Error('DSH_HOME must point to a Zero-owned profile directory');
    if (binding.harness !== 'dsh' || binding.selector !== 'profile' || !binding.verified || !isSafeProfile(binding.profile)) {
      throw new Error('DSH requires a verified profile binding with a safe profile name');
    }
    if (context.reasoningEffort) throw new Error('DSH headless CLI has no verified per-run reasoning-effort selector');

    // DSH 0.1.5-rc.2 accepts task text as positional arguments and prints one
    // final text result. It does not advertise the former --json argument.
    const args = ['--profile', binding.profile, context.prompt];
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

  protected parseOutput(stdout: string, stderr: string): ParsedOutput { return this.parsePlainText(stdout, stderr); }
}

function isSafeProfile(profile: string): boolean {
  return profile.toLowerCase() !== 'desktop' && SAFE_PROFILE.test(profile);
}
