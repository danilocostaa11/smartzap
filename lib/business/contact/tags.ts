/**
 * Helpers puros para manipular arrays de tags de contato (jsonb).
 * Mantidos sem I/O para facilitar testes unitários.
 */

export function normalizeTagName(raw: string): string {
  return String(raw || '').trim()
}

export function mergeTags(existing: string[] | null | undefined, toAdd: string[]): string[] {
  const set = new Set((existing || []).map(normalizeTagName).filter(Boolean))
  for (const tag of toAdd) {
    const n = normalizeTagName(tag)
    if (n) set.add(n)
  }
  return Array.from(set)
}

export function removeTags(existing: string[] | null | undefined, toRemove: string[]): string[] {
  const removeSet = new Set(toRemove.map(normalizeTagName).filter(Boolean))
  return (existing || []).map(normalizeTagName).filter((t) => t && !removeSet.has(t))
}

export function renameTagInList(
  existing: string[] | null | undefined,
  from: string,
  to: string
): string[] {
  const fromN = normalizeTagName(from)
  const toN = normalizeTagName(to)
  if (!fromN || !toN || fromN === toN) {
    return mergeTags(existing, [])
  }
  const without = removeTags(existing, [fromN])
  return mergeTags(without, [toN])
}

export function tagsEqualIgnoreOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].map(normalizeTagName).sort()
  const sb = [...b].map(normalizeTagName).sort()
  return sa.every((v, i) => v === sb[i])
}
