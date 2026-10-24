/** Resolve within the caller's Harness/selector scope, without hiding invalid bindings. */
export function resolveModelBinding<T extends { model: { id: string; modelId: string } }>(bindings: readonly T[], model: string): T | undefined {
  return resolveModelIdentity(bindings, model, binding => binding.model);
}

/** Local IDs take priority; legacy upstream aliases are accepted only when unique. */
export function resolveModelIdentity<T>(items: readonly T[], model: string, identity: (item: T) => { id: string; modelId: string }): T | undefined {
  const exact = items.filter(item => identity(item).id === model);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const aliases = items.filter(item => identity(item).modelId === model);
  return aliases.length === 1 ? aliases[0] : undefined;
}
