import type { Task } from './types';

export function TaskLead({ task }: { task: Task }) {
  const lead = task.bossPlan?.boss;
  if (!lead) return null;
  return <p className="task-lead" aria-label="项目负责人">Boss · {[lead.harness, lead.model, lead.reasoningEffort].filter(Boolean).join(' · ')}</p>;
}
