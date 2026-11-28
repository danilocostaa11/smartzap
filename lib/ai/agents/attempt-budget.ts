/**
 * Orçamento de tempo das chamadas ao modelo dentro de uma função serverless.
 *
 * Duas classes de chamada:
 * - "curta" (padrão, todos os agentes sem nível de raciocínio): cada tentativa tem no
 *   máximo SHORT_ATTEMPT_TIMEOUT_MS (90s), limitada ao que resta do deadline. Um timeout
 *   pode ser repetido se ainda couber outra tentativa (comportamento anterior).
 * - "longa" (agente com nível de raciocínio aplicado, ex.: Gemini 3.x em High): a
 *   tentativa usa TODO o tempo restante até o deadline, porque uma resposta High pode
 *   passar de 144s. Um timeout nessa classe já consumiu o orçamento → nunca reinicia.
 *   Erros rápidos (5xx/429/rede) só repetem se ainda sobrar LONG_ATTEMPT_MIN_BUDGET_MS,
 *   para não iniciar uma tentativa longa que estouraria o limite da função.
 *
 * Tudo é puro (recebe `now`) para ser testável sem relógio real.
 */

/** Teto por tentativa para chamadas curtas (comportamento anterior). */
export const SHORT_ATTEMPT_TIMEOUT_MS = 90_000
/** Tempo mínimo que precisa sobrar (após o backoff) para valer tentar de novo — chamada curta. */
export const SHORT_ATTEMPT_MIN_BUDGET_MS = 10_000
/**
 * Tempo mínimo que precisa sobrar (após o backoff) para iniciar outra tentativa longa.
 * Abaixo disso, uma resposta com raciocínio alto dificilmente termina a tempo.
 */
export const LONG_ATTEMPT_MIN_BUDGET_MS = 120_000
/** Piso absoluto de qualquer tentativa (evita setTimeout com valor <= 0). */
const MIN_TIMEOUT_MS = 1_000

export interface AttemptBudgetInput {
  /** true quando a chamada usa nível de raciocínio (pode demorar minutos). */
  longRunning: boolean
  /** Epoch ms em que a IA precisa ter terminado. */
  deadlineAt: number
  /** Epoch ms atual. */
  now: number
}

/** Timeout da próxima tentativa. */
export function attemptTimeoutMs({ longRunning, deadlineAt, now }: AttemptBudgetInput): number {
  const remaining = deadlineAt - now
  const capped = longRunning ? remaining : Math.min(SHORT_ATTEMPT_TIMEOUT_MS, remaining)
  return Math.max(MIN_TIMEOUT_MS, capped)
}

/** Tempo mínimo que uma nova tentativa precisa ter para valer a pena. */
export function minAttemptBudgetMs(longRunning: boolean): number {
  return longRunning ? LONG_ATTEMPT_MIN_BUDGET_MS : SHORT_ATTEMPT_MIN_BUDGET_MS
}

/**
 * Decide se pode iniciar uma nova tentativa (retry de erro transitório ou retry por
 * "LLM não chamou a tool respond").
 */
export function canStartAttempt(
  input: AttemptBudgetInput & { delayMs?: number; previousTimedOut?: boolean }
): boolean {
  const { longRunning, deadlineAt, now, delayMs = 0, previousTimedOut = false } = input
  // Tentativa longa que estourou já usou o orçamento inteiro: reiniciar só somaria tempo.
  if (longRunning && previousTimedOut) return false
  return now + delayMs + minAttemptBudgetMs(longRunning) <= deadlineAt
}
