import type { HarnessAdapter } from '../domain/types.js';
import { TaskReviewer } from '../orchestrator/reviewer.js';
import type { LocalZeroConfig } from './config-store.js';

/** Model output is a proposal; only TaskStore may publish an accepted verdict. */
export function createConfiguredTaskReviewer(options: {
  codex: HarnessAdapter;
  artifactRoot: string;
  readReviewerConfig: () => Promise<LocalZeroConfig['reviewer']>;
}) {
  return { async review(...args: Parameters<TaskReviewer['review']>) {
    const config = await options.readReviewerConfig();
    const task = args[0];
    const lead = task.bossPlan?.boss;
    if (task.boss && !lead) throw new Error('Boss project has no persisted acceptance lead');
    return new TaskReviewer({ codex: options.codex, artifactDir: options.artifactRoot,
      model: task.boss ? lead!.model : config.modelId ?? undefined,
      reasoningEffort: task.boss ? lead!.reasoningEffort : config.reasoningEffort ?? undefined }).review(...args);
  } };
}
