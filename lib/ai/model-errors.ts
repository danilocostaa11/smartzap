/**
 * Classificação de erros de provider/modelo para decidir entre RETRY e falha definitiva.
 *
 * Usado pelo chat-agent do inbox: um erro transitório (5xx, 429, timeout, rede) não
 * deve mandar a conversa para atendimento humano na primeira falha — primeiro
 * tentamos de novo com backoff. Erros de auth/config (401/403/400 em geral) não são
 * repetidos, com UMA exceção: o erro de "assistant message prefill" (400) da
 * Anthropic/OpenCode Go, que é corrigível reconstruindo o histórico para terminar
 * numa mensagem do usuário.
 *
 * Funções puras (sem I/O) — fáceis de testar. Fazem duck typing sobre o formato do
 * `APICallError` do AI SDK (`statusCode`, `isRetryable`, `responseBody`) e sobre erros
 * de rede do Node/undici (`code`, `cause`), sem depender das classes em si.
 */

export type ModelErrorKind =
  /** 400 "assistant message prefill": histórico terminou em mensagem do assistente. */
  | 'prefill'
  /** 5xx, 408/409/425/429, timeout, falha de rede: vale tentar de novo. */
  | 'transient'
  /** Auth/config/validação (4xx) ou erro desconhecido: não repetir. */
  | 'fatal'

/** Status HTTP considerados transitórios (além de qualquer 5xx). */
const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429])

/** Códigos de erro de rede do Node/undici que indicam falha transitória de conexão. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

const NETWORK_ERROR_MESSAGE = /\b(fetch failed|socket hang up|network ?error|cannot connect to api|connection (reset|refused|closed)|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i

/**
 * Mensagens da Anthropic (direto ou via OpenCode Go) quando o último item do histórico
 * é do assistente. "prefill" é o caso reportado para claude-haiku-5-5; o erro de
 * "trailing whitespace" tem a mesma causa (último turno do assistente) e a mesma correção.
 */
const PREFILL_ERROR_MESSAGE = /assistant[\s_-]*message[\s_-]*prefill|\bprefill(ing|ed)?\b|final assistant content cannot end with trailing whitespace/i

/** Limite de profundidade ao percorrer `cause` / `lastError` / `errors` (evita ciclos). */
const MAX_UNWRAP_DEPTH = 5

interface ErrorLike {
  name?: unknown
  message?: unknown
  code?: unknown
  statusCode?: unknown
  status?: unknown
  isRetryable?: unknown
  responseBody?: unknown
  response?: { status?: unknown } | null
  cause?: unknown
  /** RetryError do AI SDK */
  lastError?: unknown
  errors?: unknown
}

function asErrorLike(error: unknown): ErrorLike | null {
  return error && typeof error === 'object' ? (error as ErrorLike) : null
}

/**
 * Lista o erro e todos os erros "internos" (cause, lastError, errors[]) em ordem,
 * para que a classificação enxergue o erro de rede real por baixo de um wrapper.
 */
function unwrapErrors(error: unknown, depth = 0, seen = new Set<unknown>()): ErrorLike[] {
  const current = asErrorLike(error)
  if (!current || depth > MAX_UNWRAP_DEPTH || seen.has(current)) return []
  seen.add(current)

  const nested: unknown[] = [current.cause, current.lastError]
  if (Array.isArray(current.errors)) nested.push(...current.errors)

  return [current, ...nested.flatMap((inner) => unwrapErrors(inner, depth + 1, seen))]
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value)
  return undefined
}

/** Status HTTP do erro (APICallError.statusCode, `status`, `response.status` ou via `cause`). */
export function getModelErrorStatusCode(error: unknown): number | undefined {
  for (const err of unwrapErrors(error)) {
    const status =
      toFiniteNumber(err.statusCode) ?? toFiniteNumber(err.status) ?? toFiniteNumber(err.response?.status)
    if (status !== undefined) return status
  }
  return undefined
}

/** Texto agregado (mensagem + corpo da resposta + causas) para matching de padrões. */
export function describeModelError(error: unknown): string {
  if (typeof error === 'string') return error
  const parts: string[] = []
  for (const err of unwrapErrors(error)) {
    if (typeof err.message === 'string' && err.message) parts.push(err.message)
    if (typeof err.responseBody === 'string' && err.responseBody) parts.push(err.responseBody)
  }
  if (parts.length === 0 && error instanceof Error) parts.push(error.message)
  return parts.join(' | ')
}

/** 400 da Anthropic/OpenCode Go porque o histórico termina com mensagem do assistente. */
export function isAssistantPrefillError(error: unknown): boolean {
  return PREFILL_ERROR_MESSAGE.test(describeModelError(error))
}

/** Falha de conexão/DNS/socket (TypeError "fetch failed", ECONNRESET, undici timeouts, ...). */
export function isNetworkError(error: unknown): boolean {
  for (const err of unwrapErrors(error)) {
    if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code)) return true
    if (typeof err.message === 'string' && NETWORK_ERROR_MESSAGE.test(err.message)) return true
  }
  return false
}

export interface ClassifyModelErrorOptions {
  /** true quando a chamada foi abortada pelo nosso próprio timeout (AbortController). */
  timedOut?: boolean
}

/**
 * Erro transitório = vale tentar de novo: timeout nosso, 5xx, 408/409/425/429,
 * `isRetryable` do AI SDK, ou falha de rede. Qualquer outro 4xx (401/403/400/404/422)
 * é tratado como auth/config e NÃO é repetido.
 */
export function isTransientModelError(error: unknown, options: ClassifyModelErrorOptions = {}): boolean {
  if (options.timedOut) return true

  const status = getModelErrorStatusCode(error)
  if (status !== undefined) {
    if (status >= 500) return true
    if (TRANSIENT_STATUS_CODES.has(status)) return true
    if (status >= 400) return false
  }

  for (const err of unwrapErrors(error)) {
    if (err.isRetryable === true) return true
  }

  if (isNetworkError(error)) return true

  // Abort não provocado pelo nosso timeout (ex.: runtime encerrando) não é repetido.
  return false
}

/**
 * Classifica o erro para a política de retry do chat-agent.
 * O caso `prefill` tem prioridade: é 400, mas é corrigível (reconstruir histórico).
 */
export function classifyModelError(error: unknown, options: ClassifyModelErrorOptions = {}): ModelErrorKind {
  if (isAssistantPrefillError(error)) return 'prefill'
  return isTransientModelError(error, options) ? 'transient' : 'fatal'
}
