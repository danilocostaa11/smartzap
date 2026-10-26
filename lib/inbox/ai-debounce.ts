/**
 * Debounce + lock por conversa para o agente de IA do Inbox (Redis/Upstash).
 *
 * Problema que resolve: quando o usuário manda várias mensagens em sequência
 * (ex.: 6x "oi"), cada mensagem agenda um job em /api/ai/respond. Antes, o job
 * lia o marcador de debounce e o APAGAVA (read + delete, não atômico), então
 * jobs atrasados viam "nada" e processavam de novo → várias respostas iguais.
 *
 * Modelo novo (todas as operações são por conversa):
 *
 *   ai:lastmsg:{conversationId}     → { ts, messageId } da ÚLTIMA mensagem inbound.
 *                                     Nunca é apagado pelo job (expira por TTL).
 *                                     Só o job cujo messageId === state.messageId
 *                                     pode processar; os demais são "superseded".
 *   ai:lock:{conversationId}        → SET NX + TTL. Garante UM job gerando resposta
 *                                     por vez. Quem não consegue o lock reagenda.
 *   ai:lastanswered:{conversationId}→ id (DB) da última mensagem inbound incluída
 *                                     numa geração. Permite ao próximo job saber se
 *                                     ainda existe algo pendente para responder.
 *
 * Fail-open: se o Redis não estiver configurado ou falhar, as funções retornam
 * null/'unavailable' e o chamador segue o fluxo antigo (resposta nunca é bloqueada).
 */

import { redis } from '@/lib/redis'
import type { InboxMessage } from '@/types'

/** Fallback quando não há agente vinculado — alinhado ao default da coluna ai_agents.debounce_ms. */
export const DEFAULT_AI_DEBOUNCE_MS = 5000

/** TTL do lock de conversa (segundos). Cobre geração + envio com typing; maxDuration da rota é 300s. */
export const AI_CONVERSATION_LOCK_TTL_SECONDS = 180

/** TTL do marcador "última resposta" (segundos). Só precisa sobreviver entre um burst e o próximo. */
export const AI_LAST_ANSWERED_TTL_SECONDS = 60 * 60 * 24 * 7

export interface AIDebounceState {
  /** Date.now() da última mensagem inbound registrada */
  ts: number
  /** whatsapp_message_id da última mensagem inbound (null em registros legados) */
  messageId: string | null
}

export type DebounceDecision =
  | { action: 'process' }
  | { action: 'skip'; reason: 'superseded' | 'user-still-typing' }

export type LockResult = 'acquired' | 'busy' | 'unavailable'

const lastMsgKey = (conversationId: string) => `ai:lastmsg:${conversationId}`
const lockKey = (conversationId: string) => `ai:lock:${conversationId}`
const lastAnsweredKey = (conversationId: string) => `ai:lastanswered:${conversationId}`

function warn(label: string, error: unknown) {
  console.warn(`⚠️ [AI-DEBOUNCE] ${label}:`, error instanceof Error ? error.message : error)
}

// =============================================================================
// Marcador da última mensagem (debounce com reset)
// =============================================================================

/**
 * Registra a mensagem inbound mais recente da conversa (reset do timer de debounce).
 * Retorna false se o Redis não estiver disponível (fail-open).
 */
export async function markLatestInboundMessage(
  conversationId: string,
  messageId: string | null | undefined,
  ttlSeconds: number,
  now: number = Date.now()
): Promise<boolean> {
  if (!redis) return false
  const state: AIDebounceState = { ts: now, messageId: messageId || null }
  try {
    await redis.set(lastMsgKey(conversationId), state, { ex: Math.max(ttlSeconds, 1) })
    return true
  } catch (error) {
    warn(`Redis SET ${lastMsgKey(conversationId)} failed`, error)
    return false
  }
}

/**
 * Lê o estado de debounce da conversa. Aceita o formato legado (apenas timestamp numérico).
 * Retorna null se não houver estado ou se o Redis estiver indisponível.
 */
export async function readDebounceState(conversationId: string): Promise<AIDebounceState | null> {
  if (!redis) return null
  try {
    const raw = await redis.get<AIDebounceState | number | string>(lastMsgKey(conversationId))
    return normalizeDebounceState(raw)
  } catch (error) {
    warn(`Redis GET ${lastMsgKey(conversationId)} failed`, error)
    return null
  }
}

export function normalizeDebounceState(raw: unknown): AIDebounceState | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return { ts: raw, messageId: null }
  if (typeof raw === 'string') {
    const asNumber = Number(raw)
    if (Number.isFinite(asNumber)) return { ts: asNumber, messageId: null }
    try {
      return normalizeDebounceState(JSON.parse(raw))
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') {
    const obj = raw as Partial<AIDebounceState>
    if (typeof obj.ts !== 'number') return null
    return { ts: obj.ts, messageId: typeof obj.messageId === 'string' ? obj.messageId : null }
  }
  return null
}

/**
 * Decide se o job atual deve processar, com base no estado da conversa.
 * Função pura (sem I/O) para facilitar testes.
 *
 * - Sem estado (Redis indisponível/expirado): processa (fail-open).
 * - Existe mensagem mais recente que a deste job: 'superseded' (o job dela vai responder).
 * - Ainda dentro da janela de debounce: 'user-still-typing' (um job mais novo virá).
 */
export function evaluateDebounce(input: {
  state: AIDebounceState | null
  messageId?: string | null
  debounceMs?: number | null
  now?: number
}): DebounceDecision {
  const { state, messageId, debounceMs } = input
  if (!state) return { action: 'process' }

  if (state.messageId && messageId && state.messageId !== messageId) {
    return { action: 'skip', reason: 'superseded' }
  }

  if (debounceMs && debounceMs > 0) {
    const now = input.now ?? Date.now()
    if (now - state.ts < debounceMs) {
      return { action: 'skip', reason: 'user-still-typing' }
    }
  }

  return { action: 'process' }
}

// =============================================================================
// Lock por conversa
// =============================================================================

/**
 * Tenta adquirir o lock da conversa (SET NX EX). `token` identifica o dono (messageId).
 */
export async function acquireConversationLock(
  conversationId: string,
  token: string,
  ttlSeconds: number = AI_CONVERSATION_LOCK_TTL_SECONDS
): Promise<LockResult> {
  if (!redis) return 'unavailable'
  try {
    const result = await redis.set(lockKey(conversationId), token, { nx: true, ex: ttlSeconds })
    return result === 'OK' ? 'acquired' : 'busy'
  } catch (error) {
    warn(`Redis SET NX ${lockKey(conversationId)} failed`, error)
    return 'unavailable'
  }
}

/**
 * Libera o lock somente se ainda pertencer a `token` (evita apagar lock de outro job
 * caso o nosso tenha expirado por TTL).
 */
export async function releaseConversationLock(conversationId: string, token: string): Promise<void> {
  if (!redis) return
  try {
    const current = await redis.get<string>(lockKey(conversationId))
    if (current === token) {
      await redis.del(lockKey(conversationId))
    }
  } catch (error) {
    warn(`Redis DEL ${lockKey(conversationId)} failed`, error)
  }
}

// =============================================================================
// Última mensagem respondida
// =============================================================================

export async function getLastAnsweredMessageId(conversationId: string): Promise<string | null> {
  if (!redis) return null
  try {
    const value = await redis.get<string>(lastAnsweredKey(conversationId))
    return typeof value === 'string' && value ? value : null
  } catch (error) {
    warn(`Redis GET ${lastAnsweredKey(conversationId)} failed`, error)
    return null
  }
}

export async function setLastAnsweredMessageId(conversationId: string, messageId: string): Promise<void> {
  if (!redis) return
  try {
    await redis.set(lastAnsweredKey(conversationId), messageId, { ex: AI_LAST_ANSWERED_TTL_SECONDS })
  } catch (error) {
    warn(`Redis SET ${lastAnsweredKey(conversationId)} failed`, error)
  }
}

// =============================================================================
// Mensagens pendentes (puro)
// =============================================================================

/**
 * Retorna as mensagens inbound ainda não respondidas, em ordem cronológica.
 *
 * - Se `lastAnsweredId` estiver presente na janela, considera pendente tudo que
 *   for inbound DEPOIS dela.
 * - Caso contrário (sem Redis / fora da janela), usa a heurística: inbound após a
 *   última mensagem outbound "real" (notas internas são ignoradas).
 *
 * `messages` deve estar em ordem cronológica (como retorna inboxDb.listMessages).
 */
export function selectPendingInboundMessages(
  messages: InboxMessage[],
  lastAnsweredId?: string | null
): InboxMessage[] {
  const relevant = messages.filter((m) => m.message_type !== 'internal_note')

  let startIndex = -1
  if (lastAnsweredId) {
    startIndex = relevant.findIndex((m) => m.id === lastAnsweredId)
  }
  if (startIndex === -1) {
    for (let i = relevant.length - 1; i >= 0; i--) {
      if (relevant[i].direction === 'outbound') {
        startIndex = i
        break
      }
    }
  }

  return relevant.slice(startIndex + 1).filter((m) => m.direction === 'inbound')
}
