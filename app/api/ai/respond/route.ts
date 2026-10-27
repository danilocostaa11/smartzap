/**
 * AI Respond Endpoint - Versão Simplificada
 *
 * Endpoint único que processa mensagens do inbox com IA.
 * Substitui a arquitetura complexa de workflow durável por um fluxo direto.
 *
 * Fluxo:
 * 1. Webhook recebe mensagem → dispara via QStash.publish() (1 job por mensagem)
 * 2. Este endpoint: debounce por conversa (só o job da mensagem mais recente segue)
 *    → lock por conversa (SET NX) → busca dados → processa IA com TODAS as
 *    mensagens pendentes → envia WhatsApp → libera lock
 *
 * Um burst de N mensagens do mesmo usuário gera UMA resposta (ver lib/inbox/ai-debounce.ts).
 *
 * Robustez da chamada ao modelo:
 * - Guard de prefill: se o histórico termina em mensagem do bot (job duplicado/atrasado),
 *   a IA não é chamada (sem handoff, sem resposta) — ver lib/ai/agents/chat-history.ts.
 * - Erros transitórios do provider (5xx/429/timeout/rede/prefill) são repetidos com
 *   backoff dentro do chat-agent; o auto-handoff só acontece depois dos retries.
 *
 * Usa Fluid Compute com maxDuration=300 (5 minutos) - suficiente para 99% dos casos.
 */

import { NextRequest, NextResponse } from 'next/server'
import { inboxDb } from '@/lib/inbox/inbox-db'
import { processChatAgent, type ContactContext } from '@/lib/ai/agents/chat-agent'
import { sendWhatsAppMessage, sendTypingIndicator } from '@/lib/whatsapp-send'
import { getSupabaseAdmin } from '@/lib/supabase'
import { redis } from '@/lib/redis'
import { unauthorizedResponse } from '@/lib/auth'
import { verifyQStashOrApiKey } from '@/lib/qstash-request-auth'
import {
  acquireConversationLock,
  evaluateDebounce,
  getLastAnsweredMessageId,
  readDebounceState,
  releaseConversationLock,
  selectPendingInboundMessages,
  setLastAnsweredMessageId,
} from '@/lib/inbox/ai-debounce'
import { dispatchAIRespondJob, type AIRespondJobBody } from '@/lib/inbox/ai-dispatch'
import { hasPendingUserTurn } from '@/lib/ai/agents/chat-history'
import type { AIAgent } from '@/types'

// Fluid Compute: 5 minutos de timeout (suficiente para IA)
export const maxDuration = 300

/**
 * Reserva de tempo (ms) depois da geração para enviar a resposta pelo WhatsApp
 * (typing + split por parágrafos) ou executar o fallback de handoff. A IA (incluindo
 * retries por erro transitório) precisa terminar antes de maxDuration - esta margem.
 */
const AI_DEADLINE_MARGIN_MS = 40_000

// Desabilita cache
export const dynamic = 'force-dynamic'

// =============================================================================
// Types / constantes
// =============================================================================

type AIRespondRequest = AIRespondJobBody

/** Quantas vezes um job espera o lock da conversa (reagendando) antes de processar mesmo assim */
const MAX_LOCK_WAIT_ATTEMPTS = 20
/** Intervalo mínimo (s) entre tentativas de pegar o lock */
const MIN_LOCK_RETRY_DELAY_SECONDS = 3

// =============================================================================
// POST Handler
// =============================================================================

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  console.log(`🤖 [AI-RESPOND] ========================================`)
  console.log(`🤖 [AI-RESPOND] Request received at ${new Date().toISOString()}`)

  try {
    const rawBody = await req.text()
    const auth = await verifyQStashOrApiKey(req, rawBody)
    if (!auth.valid) {
      console.log(`❌ [AI-RESPOND] Unauthorized: ${auth.error}`)
      return unauthorizedResponse(auth.error)
    }

    // 1. Parse request
    const body = JSON.parse(rawBody) as AIRespondRequest
    const { conversationId, debounceMs, messageId } = body
    const attempt = typeof body.attempt === 'number' && body.attempt > 0 ? body.attempt : 0

    if (!conversationId) {
      console.log(`❌ [AI-RESPOND] Missing conversationId`)
      return NextResponse.json({ error: 'Missing conversationId' }, { status: 400 })
    }

    console.log(`🤖 [AI-RESPOND] Processing conversation: ${conversationId}, debounceMs: ${debounceMs}, messageId: ${messageId}, attempt: ${attempt}`)

    // 1.2. DEDUPLICAÇÃO por mensagem: essa mensagem já gerou resposta?
    // Última linha de defesa contra retry do QStash. A marcação acontece só DEPOIS
    // de adquirir o lock da conversa (ver 1.6), para que um job reagendado não se
    // auto-bloqueie. Fail-open: Redis fora → não bloqueia a resposta da IA.
    const dedupKey = messageId ? `ai:processed:${messageId}` : null
    if (dedupKey && redis) {
      try {
        const alreadyProcessed = await redis.get(dedupKey)
        if (alreadyProcessed) {
          console.log(`⏭️ [AI-RESPOND] Duplicate detected - message ${messageId} already processed at ${alreadyProcessed}`)
          return NextResponse.json({
            success: true,
            deduplicated: true,
            messageId,
            reason: 'already-processed',
          })
        }
      } catch (redisError) {
        console.warn(
          `⚠️ [AI-RESPOND] Redis dedup check failed (processing anyway):`,
          redisError instanceof Error ? redisError.message : redisError
        )
      }
    }

    // 1.5. Debounce por conversa: só o job da mensagem MAIS RECENTE responde,
    // e só depois que o usuário parou de digitar por debounceMs.
    // O marcador ai:lastmsg NÃO é apagado (expira por TTL) — jobs atrasados
    // veem que existe mensagem mais nova e saem como "superseded".
    // Fail-open: sem estado no Redis → processa.
    const debounceState = await readDebounceState(conversationId)
    const decision = evaluateDebounce({ state: debounceState, messageId, debounceMs })

    if (decision.action === 'skip') {
      if (decision.reason === 'superseded') {
        console.log(`⏭️ [AI-RESPOND] Skipping - newer message ${debounceState?.messageId} exists (this job: ${messageId})`)
      } else {
        const elapsed = debounceState ? Date.now() - debounceState.ts : 0
        console.log(`⏭️ [AI-RESPOND] Skipping - user still typing (${elapsed}ms < ${debounceMs}ms)`)
      }
      return NextResponse.json({ skipped: true, reason: decision.reason })
    }

    // 1.6. Lock por conversa (SET NX): garante UMA geração por vez.
    // Se outro job está respondendo agora (mensagem chegou durante a geração),
    // este job é reagendado e, quando rodar, só responde o que ainda estiver pendente.
    const lockToken = messageId || `job_${startTime}_${Math.random().toString(36).slice(2, 10)}`
    const lockResult = await acquireConversationLock(conversationId, lockToken)

    if (lockResult === 'busy') {
      if (attempt >= MAX_LOCK_WAIT_ATTEMPTS) {
        console.warn(`⚠️ [AI-RESPOND] Lock still busy after ${attempt} attempts - processing anyway (fail-open)`)
      } else {
        const delaySeconds = Math.max(
          MIN_LOCK_RETRY_DELAY_SECONDS,
          debounceMs && debounceMs > 0 ? Math.ceil(debounceMs / 1000) : 0
        )
        console.log(`⏳ [AI-RESPOND] Conversation ${conversationId} busy - rescheduling in ${delaySeconds}s (attempt ${attempt + 1})`)

        const rescheduled = await dispatchAIRespondJob({
          conversationId,
          debounceMs,
          messageId,
          attempt: attempt + 1,
          delaySeconds,
        })

        if (rescheduled) {
          return NextResponse.json({ skipped: true, reason: 'conversation-busy', rescheduled: true, attempt: attempt + 1 })
        }

        // Não conseguiu reagendar: devolve 503 para o QStash tentar de novo (retries: 2)
        console.error(`❌ [AI-RESPOND] Failed to reschedule busy conversation ${conversationId}`)
        return NextResponse.json(
          { skipped: true, reason: 'conversation-busy', rescheduled: false },
          { status: 503 }
        )
      }
    }

    const holdsLock = lockResult === 'acquired'
    if (holdsLock) {
      console.log(`🔒 [AI-RESPOND] Conversation lock acquired by ${lockToken}`)
    } else if (lockResult === 'unavailable') {
      console.log(`⚠️ [AI-RESPOND] Redis lock unavailable - processing without lock (fail-open)`)
    }

    try {
      // 1.7. Marca a mensagem como processada (TTL 30 min) — só depois do lock
      if (dedupKey && redis) {
        try {
          await redis.setex(dedupKey, 1800, new Date().toISOString())
        } catch (redisError) {
          console.warn(
            `⚠️ [AI-RESPOND] Redis dedup mark failed (processing anyway):`,
            redisError instanceof Error ? redisError.message : redisError
          )
        }
      }

      return await processConversation({ conversationId, startTime })
    } finally {
      if (holdsLock) {
        await releaseConversationLock(conversationId, lockToken)
        console.log(`🔓 [AI-RESPOND] Conversation lock released by ${lockToken}`)
      }
    }
  } catch (error) {
    const elapsed = Date.now() - startTime

    console.error(`💥 [AI-RESPOND] ========================================`)
    console.error(`💥 [AI-RESPOND] EXCEPTION after ${elapsed}ms`)
    console.error(`💥 [AI-RESPOND] Error:`, error)
    console.error(`💥 [AI-RESPOND] ========================================`)

    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}

// =============================================================================
// Processamento (executa com o lock da conversa)
// =============================================================================

async function processConversation(input: {
  conversationId: string
  startTime: number
}): Promise<NextResponse> {
  const { conversationId, startTime } = input

  // 2. Busca conversa
  const conversation = await inboxDb.getConversation(conversationId)

  if (!conversation) {
    console.log(`❌ [AI-RESPOND] Conversation not found: ${conversationId}`)
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // 3. Verifica se está em modo bot
  if (conversation.mode !== 'bot') {
    console.log(`⏭️ [AI-RESPOND] Skipping - mode is "${conversation.mode}", not "bot"`)
    return NextResponse.json({ skipped: true, reason: 'not-in-bot-mode' })
  }

  // 4. Verifica se automação está pausada
  if (conversation.automation_paused_until) {
    const pauseTime = new Date(conversation.automation_paused_until).getTime()
    if (pauseTime > Date.now()) {
      console.log(`⏭️ [AI-RESPOND] Skipping - automation paused until ${conversation.automation_paused_until}`)
      return NextResponse.json({ skipped: true, reason: 'automation-paused' })
    }
  }

  // 5. Busca agente
  const agent = await getAgentForConversation(conversation.ai_agent_id)

  if (!agent) {
    console.log(`❌ [AI-RESPOND] No agent configured`)
    return NextResponse.json({ error: 'No agent configured' }, { status: 400 })
  }

  if (!agent.is_active) {
    console.log(`⏭️ [AI-RESPOND] Skipping - agent "${agent.name}" is not active`)
    return NextResponse.json({ skipped: true, reason: 'agent-not-active' })
  }

  console.log(`🤖 [AI-RESPOND] Using agent: ${agent.name} (${agent.model})`)

  // 6. Busca mensagens recentes
  const { messages } = await inboxDb.listMessages(conversationId, { limit: 20 })
  console.log(`🤖 [AI-RESPOND] Found ${messages.length} messages`)

  if (messages.length === 0) {
    console.log(`⏭️ [AI-RESPOND] Skipping - no messages found`)
    return NextResponse.json({ skipped: true, reason: 'no-messages' })
  }

  // 6.5. Ainda existe algo para responder? (mensagens inbound depois da última
  // que foi incluída numa geração). Evita responder de novo quando um job
  // reagendado roda depois que outro já cobriu as mesmas mensagens.
  const lastAnsweredId = await getLastAnsweredMessageId(conversationId)
  const pendingInbound = selectPendingInboundMessages(messages, lastAnsweredId)

  if (pendingInbound.length === 0) {
    console.log(`⏭️ [AI-RESPOND] Skipping - no pending inbound messages (last answered: ${lastAnsweredId})`)
    return NextResponse.json({ skipped: true, reason: 'no-pending-inbound' })
  }

  console.log(`🤖 [AI-RESPOND] ${pendingInbound.length} pending inbound message(s) will be answered together`)

  // Contexto para a IA: histórico já respondido primeiro, mensagens pendentes por último.
  // (Uma mensagem que chegou durante a geração anterior fica, no banco, ANTES da resposta
  // anterior; para o modelo ela precisa aparecer DEPOIS, como a vez atual do usuário.)
  const pendingIds = new Set(pendingInbound.map((m) => m.id))
  const messagesForAI = [...messages.filter((m) => !pendingIds.has(m.id)), ...pendingInbound]

  // 6.6. Guard de prefill: o histórico enviado ao modelo PRECISA terminar numa mensagem
  // do usuário (Claude via OpenCode Go rejeita "assistant message prefill"). Se a última
  // mensagem é do bot, a resposta já saiu — pula a IA sem handoff e sem nova resposta.
  if (!hasPendingUserTurn(messagesForAI)) {
    console.log(`⏭️ [AI-RESPOND] Skipping AI call - history ends with an assistant message (reply already sent)`)
    return NextResponse.json({ skipped: true, reason: 'no-pending-user-message' })
  }

  // Registra ANTES de gerar: se outra mensagem chegar durante a geração, o job dela
  // vai saber exatamente a partir de onde ainda falta responder.
  const newestInbound = pendingInbound[pendingInbound.length - 1]
  await setLastAnsweredMessageId(conversationId, newestInbound.id)

  // 7. Busca dados do contato (se existir)
  let contactData: ContactContext | undefined
  if (conversation.contact_id) {
    contactData = await getContactData(conversation.contact_id)
    if (contactData) {
      console.log(`🤖 [AI-RESPOND] Contact data loaded: ${contactData.name || 'unnamed'}`)
    }
  }

  // 8. Processa com IA
  console.log(`🚀 [AI-RESPOND] Calling processChatAgent...`)

  const result = await processChatAgent({
    agent,
    conversation,
    messages: messagesForAI,
    contactData,
    // A IA (com retries por erro transitório) precisa terminar a tempo de enviarmos a resposta
    deadlineAt: startTime + maxDuration * 1000 - AI_DEADLINE_MARGIN_MS,
  })

  console.log(`✅ [AI-RESPOND] AI result: success=${result.success}, latency=${result.latencyMs}ms`)

  // 8. IA pulada de propósito (ex.: prefill — histórico sem turno do usuário pendente):
  // nada a responder, sem handoff.
  if (result.skipped) {
    console.log(`⏭️ [AI-RESPOND] AI call skipped by chat-agent: ${result.skipReason}`)
    return NextResponse.json({ skipped: true, reason: result.skipReason })
  }

  // 8. Trata erro da IA (já passou pelos retries de erro transitório no chat-agent)
  if (!result.success || !result.response?.message) {
    console.log(`❌ [AI-RESPOND] AI failed after retries: ${result.error}`)

    // Auto-handoff em caso de erro
    await handleAutoHandoff(conversationId, conversation.phone, result.error || 'AI processing failed')

    return NextResponse.json({
      success: false,
      error: result.error || 'Empty response',
      handedOff: true,
    })
  }

  // 9. Envia resposta via WhatsApp (com split por parágrafos)
  console.log(`📤 [AI-RESPOND] Sending WhatsApp message to ${conversation.phone}...`)

  // Busca o whatsapp_message_id da ÚLTIMA mensagem inbound para typing indicator e quote
  // IMPORTANTE: usar findLast() para pegar a mais recente, não a primeira
  const lastInboundMessage = messagesForAI.findLast(m => m.direction === 'inbound' && m.whatsapp_message_id)
  const typingMessageId = lastInboundMessage?.whatsapp_message_id

  if (typingMessageId) {
    console.log(`⌨️ [AI-RESPOND] Will use typing indicator with message_id: ${typingMessageId}`)
  } else {
    console.log(`⚠️ [AI-RESPOND] No inbound message_id found, typing indicator disabled`)
  }

  // Split por \n\n (igual Evolution API) - cada parágrafo vira uma mensagem
  const messageParts = splitMessageByParagraphs(result.response.message)
  console.log(`📤 [AI-RESPOND] Message split into ${messageParts.length} parts`)

  const messageIds: string[] = []

  for (let i = 0; i < messageParts.length; i++) {
    const part = messageParts[i]

    // Envia typing indicator antes de cada parte (se tiver message_id)
    if (typingMessageId) {
      await sendTypingIndicator({ messageId: typingMessageId })
      console.log(`⌨️ [AI-RESPOND] Typing indicator sent for part ${i + 1}`)
    }

    // Delay proporcional ao tamanho da mensagem (simula digitação)
    // 10ms por caractere, mínimo 800ms, máximo 2s
    const typingDelay = Math.min(Math.max(part.length * 10, 800), 2000)
    await new Promise(r => setTimeout(r, typingDelay))

    // Se shouldQuoteUserMessage e é a primeira parte, envia como reply
    const shouldQuote = i === 0 && result.response.shouldQuoteUserMessage && typingMessageId

    const sendResult = await sendWhatsAppMessage({
      to: conversation.phone,
      type: 'text',
      text: part,
      replyToMessageId: shouldQuote ? typingMessageId : undefined,
    })

    if (shouldQuote) {
      console.log(`💬 [AI-RESPOND] First message sent as reply to user message`)
    }

    if (sendResult.success && sendResult.messageId) {
      messageIds.push(sendResult.messageId)

      // Salva cada parte no banco
      await inboxDb.createMessage({
        conversation_id: conversationId,
        direction: 'outbound',
        content: part,
        message_type: 'text',
        whatsapp_message_id: sendResult.messageId,
        delivery_status: 'sent',
        ai_response_id: i === 0 ? result.logId || null : null, // Só a primeira tem o logId
        ai_sentiment: i === messageParts.length - 1 ? result.response.sentiment : null, // Só a última tem sentiment
        ai_sources: i === messageParts.length - 1 ? result.response.sources || null : null,
      })

      console.log(`✅ [AI-RESPOND] Part ${i + 1}/${messageParts.length} sent: ${sendResult.messageId}`)

      // Pausa entre mensagens para o typing da próxima ser mais visível
      if (i < messageParts.length - 1) {
        await new Promise(r => setTimeout(r, 500)) // 500ms de "respiro"
      }
    } else {
      console.error(`❌ [AI-RESPOND] Failed to send part ${i + 1}:`, sendResult.error)
    }
  }

  console.log(`✅ [AI-RESPOND] All ${messageIds.length} messages sent`)

  // 10. Handoff se necessário
  if (result.response.shouldHandoff) {
    console.log(`🔄 [AI-RESPOND] Processing handoff request...`)

    await inboxDb.updateConversation(conversationId, { mode: 'human' })

    await inboxDb.createMessage({
      conversation_id: conversationId,
      direction: 'outbound',
      content: `🤖 **Transferência para atendente**\n\n${result.response.handoffReason ? `**Motivo:** ${result.response.handoffReason}\n` : ''}${result.response.handoffSummary ? `**Resumo:** ${result.response.handoffSummary}` : ''}`,
      message_type: 'internal_note',
      delivery_status: 'delivered',
      payload: {
        type: 'ai_handoff',
        reason: result.response.handoffReason,
        summary: result.response.handoffSummary,
        timestamp: new Date().toISOString(),
      },
    })

    console.log(`✅ [AI-RESPOND] Handoff completed`)
  }

  const elapsed = Date.now() - startTime

  console.log(`🎉 [AI-RESPOND] ========================================`)
  console.log(`🎉 [AI-RESPOND] COMPLETED in ${elapsed}ms`)
  console.log(`🎉 [AI-RESPOND] Sentiment: ${result.response.sentiment}`)
  console.log(`🎉 [AI-RESPOND] Handoff: ${result.response.shouldHandoff}`)
  console.log(`🎉 [AI-RESPOND] ========================================`)

  return NextResponse.json({
    success: true,
    conversationId,
    answeredMessages: pendingInbound.length,
    sentiment: result.response.sentiment,
    handoff: result.response.shouldHandoff,
    latencyMs: elapsed,
  })
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Busca dados do contato para injetar no contexto da IA
 */
async function getContactData(contactId: string): Promise<ContactContext | undefined> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return undefined

  const { data, error } = await supabase
    .from('contacts')
    .select('name, email, created_at')
    .eq('id', contactId)
    .single()

  if (error || !data) return undefined

  return {
    name: data.name || undefined,
    email: data.email || undefined,
    created_at: data.created_at || undefined,
  }
}

/**
 * Busca o agente de IA para uma conversa
 * Prioridade: agente específico da conversa → agente padrão
 */
async function getAgentForConversation(agentId: string | null): Promise<AIAgent | null> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return null

  // Tenta agente específico
  if (agentId) {
    const { data } = await supabase.from('ai_agents').select('*').eq('id', agentId).single()
    if (data) return data as AIAgent
  }

  // Fallback para agente padrão
  const { data } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('is_active', true)
    .eq('is_default', true)
    .single()

  return (data as AIAgent) || null
}

/**
 * Auto-handoff em caso de erro
 * Envia mensagem de fallback e transfere para humano
 */
async function handleAutoHandoff(
  conversationId: string,
  phone: string,
  errorMessage: string
): Promise<void> {
  console.log(`🚨 [AI-RESPOND] Auto-handoff due to error: ${errorMessage}`)

  const fallbackMessage =
    'Desculpe, estou com dificuldades técnicas. Vou transferir você para um atendente.'

  // Envia mensagem de fallback
  const sendResult = await sendWhatsAppMessage({
    to: phone,
    type: 'text',
    text: fallbackMessage,
  })

  if (sendResult.success && sendResult.messageId) {
    await inboxDb.createMessage({
      conversation_id: conversationId,
      direction: 'outbound',
      content: fallbackMessage,
      message_type: 'text',
      whatsapp_message_id: sendResult.messageId,
      delivery_status: 'sent',
    })
  }

  // Muda para modo humano
  await inboxDb.updateConversation(conversationId, { mode: 'human' })

  // Cria nota interna
  await inboxDb.createMessage({
    conversation_id: conversationId,
    direction: 'outbound',
    content: `🤖 **Transferência automática**\n\n**Motivo:** Erro técnico: ${errorMessage}`,
    message_type: 'internal_note',
    delivery_status: 'delivered',
  })
}

/**
 * Divide mensagem por parágrafos (double line breaks)
 * Igual ao Evolution API - cada parágrafo vira uma mensagem separada
 */
function splitMessageByParagraphs(message: string): string[] {
  return message
    .split('\n\n')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}
