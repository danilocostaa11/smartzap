/**
 * Capacidades por modelo — parâmetros de sampling.
 *
 * Fonte única de verdade sobre quais modelos aceitam `temperature`. Usada em
 * TODOS os caminhos de geração de texto (chat-agent do inbox, chat de teste do
 * agente, /api/ai-agents/[id]/chat, inbox/chat, inbox/suggest e o serviço
 * unificado), para que um modelo que rejeita o parâmetro nunca o receba.
 *
 * Contexto: modelos Claude a partir da geração 5 (`claude-haiku-5-5`,
 * `claude-opus-5-5`, `claude-sonnet-5-5`, ...) respondem 400
 * `invalid_request_error: \`temperature\` is deprecated for this model` quando o
 * parâmetro é enviado — tanto na API da Anthropic quanto via gateways (OpenCode Go).
 *
 * Client-safe: sem imports de servidor (também usado na UI do formulário do agente).
 */

/** Temperatura padrão usada quando o agente/chamada não define uma. */
export const DEFAULT_TEMPERATURE = 0.7

/**
 * Geração mínima do Claude a partir da qual `temperature` é rejeitada.
 * Ids cobertos: `claude-<família>-<major>[-<minor>][-<data>]` e o formato
 * antigo `claude-<major>-<minor>-<família>` (ex.: `claude-3-5-haiku`).
 */
const CLAUDE_NO_TEMPERATURE_MIN_MAJOR = 5

const CLAUDE_MODEL_RE = /^claude-(?:(?:haiku|opus|sonnet)-)?(\d+)(?:[.-]\d+)?/i

/** Remove prefixo de provider (`anthropic/claude-...`, `opencode_go/claude-...`). */
function stripProviderPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/**
 * Indica se o modelo aceita o parâmetro `temperature`.
 *
 * Retorna `true` por padrão (comportamento atual preservado) e `false` apenas
 * para famílias conhecidas por rejeitar o parâmetro.
 */
export function supportsTemperature(modelId: string | null | undefined): boolean {
  const id = stripProviderPrefix((modelId || '').trim().toLowerCase())
  if (!id) return true

  const claude = CLAUDE_MODEL_RE.exec(id)
  if (claude) {
    const major = Number.parseInt(claude[1], 10)
    return !(Number.isFinite(major) && major >= CLAUDE_NO_TEMPERATURE_MIN_MAJOR)
  }

  return true
}

/**
 * Resolve a temperatura a enviar ao provider para um modelo.
 *
 * - Modelo aceita `temperature` → valor configurado (ou `fallback`).
 * - Modelo rejeita `temperature` → `undefined` (o AI SDK omite o campo do payload).
 *
 * Deve receber o id de modelo JÁ RESOLVIDO para o provider ativo (ex.: o id que
 * `resolveOpenCodeGoModelId` devolve), não o id bruto salvo no agente.
 */
export function resolveTemperature(
  modelId: string | null | undefined,
  requested?: number | null,
  fallback: number = DEFAULT_TEMPERATURE,
): number | undefined {
  if (!supportsTemperature(modelId)) return undefined
  return requested ?? fallback
}
