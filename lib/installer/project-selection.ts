/**
 * Seleção segura do projeto Vercel alvo do instalador.
 *
 * Um mesmo time Vercel pode ter VÁRIAS instâncias SmartZap (uma por número de
 * WhatsApp: smartzap-lia, smartzap-lia-02, ...). O instalador NUNCA pode escolher
 * "o primeiro projeto com smartzap no nome", senão grava envs/redeploy na
 * instância errada.
 *
 * Regra:
 * 1. Em runtime na Vercel, `VERCEL_PROJECT_ID` (variável de sistema) identifica
 *    exatamente o projeto deste deploy → usa só ele. Se não estiver acessível
 *    com o token, ERRO (sem fallback).
 * 2. Sem `VERCEL_PROJECT_ID` (dev local): se `VERCEL_PROJECT_NAME` existir,
 *    exige nome exato; senão mantém o comportamento legado (nome contém
 *    "smartzap" → primeiro da lista).
 */

export interface VercelProjectLike {
  id: string
  name: string
  accountId?: string
  ownerId?: string
  [key: string]: unknown
}

export type ProjectSelection<T extends VercelProjectLike> =
  | { ok: true; project: T; reason: 'project-id' | 'project-name' | 'legacy' }
  | { ok: false; error: string; needsFetchById?: string }

export function selectInstallerProject<T extends VercelProjectLike>(
  projects: T[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): ProjectSelection<T> {
  const projectId = env.VERCEL_PROJECT_ID?.trim()
  if (projectId) {
    const match = projects.find((p) => p.id === projectId)
    if (match) return { ok: true, project: match, reason: 'project-id' }
    return {
      ok: false,
      needsFetchById: projectId,
      error:
        'O projeto Vercel deste deploy não está acessível com este token. Use um token do mesmo time/conta do projeto.',
    }
  }

  const projectName = env.VERCEL_PROJECT_NAME?.trim().toLowerCase()
  if (projectName) {
    const match = projects.find((p) => p.name.toLowerCase() === projectName)
    if (match) return { ok: true, project: match, reason: 'project-name' }
    return { ok: false, error: `Projeto Vercel "${projectName}" não encontrado com este token.` }
  }

  const legacy =
    projects.find((p) => p.name.toLowerCase().includes('smartzap')) ?? projects[0]
  if (legacy) return { ok: true, project: legacy, reason: 'legacy' }
  return { ok: false, error: 'Nenhum projeto encontrado na Vercel. Crie um projeto primeiro.' }
}

/**
 * Lista projetos e aplica `selectInstallerProject`; quando o projeto do deploy
 * não veio na listagem (paginação), busca por id diretamente.
 */
export async function resolveInstallerProject<T extends VercelProjectLike>(
  token: string,
  projects: T[],
  fetchImpl: typeof fetch = fetch
): Promise<ProjectSelection<T>> {
  const selection = selectInstallerProject(projects)
  if (selection.ok || !selection.needsFetchById) return selection

  const res = await fetchImpl(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(selection.needsFetchById)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return { ok: false, error: selection.error }
  const project = (await res.json()) as T
  if (project?.id !== selection.needsFetchById) return { ok: false, error: selection.error }
  return { ok: true, project, reason: 'project-id' }
}
