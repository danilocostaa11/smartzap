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

// =============================================================================
// Nível de raciocínio (thinking) — Gemini 3.x
// =============================================================================

/**
 * Níveis aceitos pela API Gemini em `thinkingConfig.thinkingLevel`.
 * Ref: https://ai.google.dev/gemini-api/docs/thinking
 */
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * Piso de `maxOutputTokens` quando um nível de raciocínio é aplicado.
 * No Gemini os tokens de raciocínio contam dentro do limite de saída; com o
 * limite padrão do agente (1024–2048) um nível alto pode esgotar o orçamento
 * antes da resposta. O tamanho da resposta continua guiado pelo prompt.
 */
export const REASONING_MIN_OUTPUT_TOKENS = 8192

const GEMINI_3_RE = /^gemini-3(?:[.-]|$)/i

/** Indica se o modelo aceita `thinkingLevel` (família Gemini 3.x). */
export function supportsReasoningLevel(modelId: string | null | undefined): boolean {
  const id = stripProviderPrefix((modelId || '').trim().toLowerCase())
  return GEMINI_3_RE.test(id)
}

/** Normaliza o valor salvo no agente; inválido/vazio → null (padrão do modelo). */
export function normalizeReasoningLevel(value: unknown): ReasoningLevel | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return (REASONING_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : null
}

/**
 * Nível efetivo para a chamada: só quando o modelo suporta e o agente definiu.
 * Deve receber o id de modelo JÁ RESOLVIDO para o provider ativo.
 */
export function resolveReasoningLevel(
  modelId: string | null | undefined,
  requested: unknown,
): ReasoningLevel | null {
  if (!supportsReasoningLevel(modelId)) return null
  return normalizeReasoningLevel(requested)
}

/**
 * `providerOptions` para o AI SDK. `undefined` quando não há nível a aplicar,
 * preservando exatamente o payload atual dos demais agentes/provedores.
 */
export function resolveProviderOptions(
  modelId: string | null | undefined,
  requested: unknown,
): { google: { thinkingConfig: { thinkingLevel: ReasoningLevel } } } | undefined {
  const level = resolveReasoningLevel(modelId, requested)
  if (!level) return undefined
  return { google: { thinkingConfig: { thinkingLevel: level } } }
}

/** `maxOutputTokens` com piso quando há nível de raciocínio aplicado. */
export function resolveMaxOutputTokens(
  modelId: string | null | undefined,
  requested: unknown,
  maxTokens: number,
): number {
  if (!resolveReasoningLevel(modelId, requested)) return maxTokens
  return Math.max(maxTokens, REASONING_MIN_OUTPUT_TOKENS)
}
