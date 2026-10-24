/** Resolve within the caller's Harness/selector scope, without hiding invalid bindings. */
export function resolveModelBinding<T extends { model: { id: string; modelId: string } }>(bindings: readonly T[], model: string): T | undefined {
  const exact = bindings.filter(binding => binding.model.id === model);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const aliases = bindings.filter(binding => binding.model.modelId === model);
  return aliases.length === 1 ? aliases[0] : undefined;
}
