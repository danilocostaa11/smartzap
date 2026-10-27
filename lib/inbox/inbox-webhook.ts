/**
 * T046-T048: Inbox Webhook Integration
 * Handles inbox-related webhook events:
 * - T046: Persist inbound messages to inbox_messages
 * - T047: Trigger AI processing when mode = 'bot'
 * - T048: Update delivery status in inbox_messages
 *
 * OTIMIZAÇÕES V2 (2026-01-26):
 * - RPC process_inbound_message: 4-5 queries → 1 chamada
 * - Fallback automático para versão anterior se RPC não existir
 */

import { getSupabaseAdmin } from '@/lib/supabase'
import { normalizePhoneNumber } from '@/lib/phone-formatter'
import { inboxDb, isHumanModeExpired, switchToBotMode, findConversationByPhoneLightweight } from './inbox-db'
import { cancelDebounce } from '@/lib/ai/agents/chat-agent'
import { sendWhatsAppMessage } from '@/lib/whatsapp-send'
import { DEFAULT_AI_DEBOUNCE_MS, markLatestInboundMessage } from './ai-debounce'
import { dispatchAIRespondJob, isAIDispatchAvailable } from './ai-dispatch'
import type {
  InboxConversation,
  InboxMessage,
  AIAgent,
} from '@/types'

// Tipo para conversa lightweight (retorno otimizado do webhook)
type LightweightConversation = Awaited<ReturnType<typeof findConversationByPhoneLightweight>>

// Tipo do retorno da RPC process_inbound_message
interface ProcessInboundMessageResult {
  conversation_id: string
  message_id: string
  is_new_conversation: boolean
  conversation_status: string
  conversation_mode: string
  ai_agent_id: string | null
  human_mode_expires_at: string | null
  automation_paused_until: string | null
}

// =============================================================================
// Types
// =============================================================================

export interface InboundMessagePayload {
  /** WhatsApp message ID */
  messageId: string
  /** Sender phone number (raw format from webhook) */
  from: string
  /** Message type (text, image, interactive, etc) */
  type: string
  /** Text content (extracted from various message formats) */
  text: string
  /** Raw message timestamp from Meta */
  timestamp?: string
  /** Media URL if applicable */
  mediaUrl?: string | null
  /** Phone number ID that received the message */
  phoneNumberId?: string
}

export interface StatusUpdatePayload {
  /** WhatsApp message ID */
  messageId: string
  /** Status (sent, delivered, read, failed) */
  status: 'sent' | 'delivered' | 'read' | 'failed'
  /** Timestamp from webhook */
  timestamp?: string
  /** Error details if failed */
  errors?: Array<{ code: number; title: string; message?: string }>
}

// =============================================================================
// Inbound Message Handler (T046)
// =============================================================================

/**
 * Process an inbound message using optimized RPC (V2)
 * Executes conversation upsert + message creation + counter updates in a single DB call
 *
 * OTIMIZAÇÕES V2 (2026-01-26):
 * 1. RPC process_inbound_message: 4-5 queries → 1 chamada atômica
 * 2. Fallback automático para versão legacy se RPC não existir
 */
export async function handleInboundMessage(
  payload: InboundMessagePayload
): Promise<{
  conversationId: string
  messageId: string
  triggeredAI: boolean
}> {
  const normalizedPhone = normalizePhoneNumber(payload.from)
  const supabase = getSupabaseAdmin()

  // Tenta usar RPC otimizada (V2)
  // Fix aplicado em 20260203000000_fix_process_inbound_message_types.sql
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('process_inbound_message', {
        p_phone: normalizedPhone,
        p_content: payload.text || `[${payload.type}]`,
        p_whatsapp_message_id: payload.messageId || null,
        p_message_type: mapMessageType(payload.type),
        p_media_url: payload.mediaUrl || null,
        p_payload: {
          raw_type: payload.type,
          timestamp: payload.timestamp,
          phone_number_id: payload.phoneNumberId,
        },
        p_contact_id: null, // Contact lookup done inside RPC if needed
      })

      if (!error && data) {
        const result = data as ProcessInboundMessageResult
        console.log(`⚡ [INBOX] RPC process_inbound_message OK: conv=${result.conversation_id}, msg=${result.message_id}, new=${result.is_new_conversation}`)

        // Trigger AI se necessário
        let triggeredAI = false
        let currentMode = result.conversation_mode

        // Check if human mode has expired
        if (currentMode === 'human' && result.human_mode_expires_at) {
          if (isHumanModeExpired(result.human_mode_expires_at)) {
            console.log(`[Inbox] Human mode expired for ${result.conversation_id}, auto-switching to bot mode`)
            await switchToBotMode(result.conversation_id)
            currentMode = 'bot'
          }
        }

        if (currentMode === 'bot') {
          if (isAutomationPaused(result.automation_paused_until)) {
            console.log(`[Inbox] Automation paused until ${result.automation_paused_until}, skipping AI`)
          } else {
            // A RPC cria conversas com mode='bot' mas SEM ai_agent_id. Sem o vínculo,
            // get_agent_config cai no fallback e ignora o debounce configurado no agente.
            const aiAgentId = await ensureConversationAgent(result.conversation_id, result.ai_agent_id)

            // Cria objeto lightweight para triggerAIProcessing
            const conversationForTrigger = {
              id: result.conversation_id,
              phone: normalizedPhone,
              status: result.conversation_status,
              mode: currentMode,
              ai_agent_id: aiAgentId,
              human_mode_expires_at: result.human_mode_expires_at,
              automation_paused_until: result.automation_paused_until,
            } as InboxConversation

            const messageForTrigger = {
              id: result.message_id,
              conversation_id: result.conversation_id,
              whatsapp_message_id: payload.messageId, // Necessário para deduplicação
            } as InboxMessage

            triggeredAI = await triggerAIProcessing(conversationForTrigger, messageForTrigger)
          }
        }

        return {
          conversationId: result.conversation_id,
          messageId: result.message_id,
          triggeredAI,
        }
      }

      // Se RPC não existe ou falhou, usa fallback
      if (error?.code === '42883') {
        console.log('[Inbox] RPC process_inbound_message não existe, usando fallback legacy')
      } else if (error) {
        console.warn('[Inbox] RPC error, usando fallback:', error.message)
      }
    } catch (rpcError) {
      console.warn('[Inbox] RPC exception, usando fallback:', rpcError)
    }
  }

  // FALLBACK: Versão legacy (4-5 queries)
  return handleInboundMessageLegacy(payload, normalizedPhone)
}

/**
 * Versão legacy do handleInboundMessage (fallback se RPC não existir)
 */
async function handleInboundMessageLegacy(
  payload: InboundMessagePayload,
  normalizedPhone: string
): Promise<{
  conversationId: string
  messageId: string
  triggeredAI: boolean
}> {
  // 1. Busca conversa existente (versão LIGHTWEIGHT - sem JOINs)
  let conversation = await findConversationByPhoneLightweight(normalizedPhone)

  if (!conversation) {
    // Paraleliza: busca contato enquanto prepara criação da conversa
    const contactId = await findContactId(normalizedPhone)
    const fullConversation = await inboxDb.createConversation({
      phone: normalizedPhone,
      contact_id: contactId || undefined,
      mode: 'bot',
    })
    conversation = {
      id: fullConversation.id,
      phone: fullConversation.phone,
      status: fullConversation.status,
      mode: fullConversation.mode,
      ai_agent_id: fullConversation.ai_agent_id,
      contact_id: fullConversation.contact_id,
      human_mode_expires_at: fullConversation.human_mode_expires_at,
      automation_paused_until: fullConversation.automation_paused_until,
      total_messages: fullConversation.total_messages,
      unread_count: fullConversation.unread_count,
    }
  } else if (conversation.status === 'closed') {
    await inboxDb.updateConversation(conversation.id, { status: 'open' })
  }

  // 2. Cria mensagem
  const message = await inboxDb.createMessage({
    conversation_id: conversation.id,
    direction: 'inbound',
    content: payload.text || `[${payload.type}]`,
    message_type: mapMessageType(payload.type),
    whatsapp_message_id: payload.messageId || undefined,
    media_url: payload.mediaUrl || undefined,
    delivery_status: 'delivered',
    payload: {
      raw_type: payload.type,
      timestamp: payload.timestamp,
      phone_number_id: payload.phoneNumberId,
    },
  })

  // 3. Trigger AI
  let triggeredAI = false
  let currentMode = conversation.mode

  if (currentMode === 'human' && isHumanModeExpired(conversation.human_mode_expires_at)) {
    await switchToBotMode(conversation.id)
    currentMode = 'bot'
  }

  if (currentMode === 'bot' && !isAutomationPaused(conversation.automation_paused_until)) {
    const aiAgentId = await ensureConversationAgent(conversation.id, conversation.ai_agent_id)
    triggeredAI = await triggerAIProcessing(
      { ...conversation, ai_agent_id: aiAgentId } as InboxConversation,
      message
    )
  }

  return {
    conversationId: conversation.id,
    messageId: message.id,
    triggeredAI,
  }
}

// =============================================================================
// AI Processing Trigger (T047) - Via QStash com Debounce Reset + lock por conversa
// =============================================================================

/**
 * Trigger AI agent processing via QStash com "debounce com reset"
 *
 * Implementa o padrão usado por n8n, Typebot, Botpress etc:
 * - A cada mensagem, RESETA o timer de espera
 * - Só processa quando o usuário PARA de digitar por X segundos
 *
 * Fluxo:
 * 1. Busca agente para pegar debounce_ms configurado (fallback: DEFAULT_AI_DEBOUNCE_MS)
 * 2. Registra no Redis { ts, messageId } da ÚLTIMA mensagem da conversa
 * 3. Agenda job com delay = debounce_ms
 * 4. Quando o job executa (app/api/ai/respond):
 *    - Se existe mensagem mais recente que a dele → skip (superseded)
 *    - Se ainda não passou debounce_ms → skip (user-still-typing)
 *    - Caso contrário adquire o lock da conversa e responde TODAS as mensagens pendentes
 */
async function triggerAIProcessing(
  conversation: InboxConversation,
  message: InboxMessage
): Promise<boolean> {
  const conversationId = conversation.id
  const messageId = message.whatsapp_message_id // Usado para deduplicação e "mensagem mais recente"
  const now = Date.now()

  console.log(`🔥 [TRIGGER] Starting AI processing for ${conversationId}, messageId=${messageId}`)

  if (!isAIDispatchAvailable()) {
    console.log('[Inbox] QStash client not available, skipping AI processing')
    return false
  }

  // 1. Busca o agente para pegar o debounce_ms configurado
  const agent = await getAgentForTrigger(conversation.ai_agent_id, conversationId)
  const debounceMs = agent?.debounce_ms ?? DEFAULT_AI_DEBOUNCE_MS
  const debounceSeconds = Math.ceil(debounceMs / 1000)

  console.log(`🔥 [TRIGGER] Agent debounce: ${debounceMs}ms (${debounceSeconds}s)`)

  // 2. Registra a ÚLTIMA MENSAGEM da conversa no Redis (reset do timer + "quem responde").
  // Feito mesmo com debounce=0: o job só processa se for o da mensagem mais recente.
  // Fail-open: Redis morto/DNS inválido NÃO pode impedir o QStash de disparar a IA.
  const marked = await markLatestInboundMessage(conversationId, messageId, debounceSeconds + 120, now)
  if (marked) {
    console.log(`🔥 [TRIGGER] Redis lastmsg ${conversationId} = ${messageId} @ ${now}`)
  } else {
    console.log(`⚠️ [TRIGGER] Redis not available, debounce/lock will be best-effort`)
  }

  // 3. Agenda job com delay (0 = imediato quando debounce desabilitado)
  return await dispatchAIRespondJob({
    conversationId,
    debounceMs,
    delaySeconds: debounceMs === 0 ? 0 : debounceSeconds,
    messageId,
  })
}

/**
 * Garante que a conversa em modo bot esteja vinculada a um agente de IA.
 *
 * A RPC process_inbound_message cria conversas sem ai_agent_id; sem o vínculo,
 * get_agent_config retorna o fallback de debounce e ignora o "Tempo de Espera"
 * configurado no agente. Resolve o agente padrão ativo e persiste o vínculo
 * (best-effort, só quando ainda está nulo). Retorna o agentId efetivo.
 */
async function ensureConversationAgent(
  conversationId: string,
  currentAgentId: string | null | undefined
): Promise<string | null> {
  if (currentAgentId) return currentAgentId

  const supabase = getSupabaseAdmin()
  if (!supabase) return null

  try {
    const { data: agent, error } = await supabase
      .from('ai_agents')
      .select('id')
      .eq('is_active', true)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle()

    if (error || !agent?.id) {
      if (error) console.warn('[Inbox] Falha ao buscar agente padrão:', error.message)
      return null
    }

    const { error: updateError } = await supabase
      .from('inbox_conversations')
      .update({ ai_agent_id: agent.id })
      .eq('id', conversationId)
      .is('ai_agent_id', null)

    if (updateError) {
      console.warn(`[Inbox] Falha ao vincular agente ${agent.id} à conversa ${conversationId}:`, updateError.message)
    } else {
      console.log(`🔗 [Inbox] Conversa ${conversationId} vinculada ao agente padrão ${agent.id}`)
    }

    return agent.id
  } catch (e) {
    console.warn('[Inbox] ensureConversationAgent exception:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Helper: Busca agente para pegar debounce_ms
 *
 * Prioridade:
 * 1. Agente vinculado à conversa (query direta por id)
 * 2. RPC get_agent_config (JOIN conversa → agente) — só vale se retornar ai_agent_id
 * 3. Agente padrão ativo
 *
 * Versão leve que só busca os campos necessários
 */
async function getAgentForTrigger(agentId: string | null, conversationId?: string): Promise<Pick<AIAgent, 'debounce_ms'> | null> {
  const supabase = getSupabaseAdmin()
  if (!supabase) return null

  // 1. Agente vinculado à conversa
  if (agentId) {
    const { data } = await supabase
      .from('ai_agents')
      .select('debounce_ms')
      .eq('id', agentId)
      .single()
    if (data) return { debounce_ms: data.debounce_ms ?? DEFAULT_AI_DEBOUNCE_MS }
  }

  // 2. RPC get_agent_config (se não sabemos o agentId)
  if (!agentId && conversationId) {
    try {
      const { data, error } = await supabase.rpc('get_agent_config', {
        p_conversation_id: conversationId,
      })

      if (!error && data?.ai_agent_id) {
        console.log(`⚡ [TRIGGER] RPC get_agent_config OK: debounce=${data.debounce_ms}ms`)
        return { debounce_ms: data.debounce_ms ?? DEFAULT_AI_DEBOUNCE_MS }
      }

      // Conversa sem agente vinculado → a RPC devolve só o fallback; usa agente padrão abaixo
      if (error?.code === '42883') {
        console.log('[TRIGGER] RPC get_agent_config não existe, usando fallback')
      }
    } catch {
      // Fallback silencioso
    }
  }

  // 3. Agente padrão ativo
  const { data } = await supabase
    .from('ai_agents')
    .select('debounce_ms')
    .eq('is_active', true)
    .eq('is_default', true)
    .single()

  return data ? { debounce_ms: data.debounce_ms ?? DEFAULT_AI_DEBOUNCE_MS } : null
}

/**
 * Handle AI handoff to human
 * Switches conversation mode and creates internal note
 */
async function handleAIHandoff(
  conversation: InboxConversation,
  reason?: string,
  summary?: string
): Promise<void> {
  console.log(
    `[Inbox] AI handoff for conversation ${conversation.id}: ${reason}`
  )

  // Switch to human mode
  await inboxDb.updateConversation(conversation.id, { mode: 'human' })

  // Cancel any pending debounce
  cancelDebounce(conversation.id)

  // Create internal note about handoff
  await inboxDb.createMessage({
    conversation_id: conversation.id,
    direction: 'outbound',
    content: `🤖 **Transferência para atendente**\n\n${reason ? `**Motivo:** ${reason}\n` : ''}${summary ? `**Resumo:** ${summary}` : ''}`,
    message_type: 'internal_note',
    delivery_status: 'delivered',
    payload: {
      type: 'ai_handoff',
      reason,
      summary,
      timestamp: new Date().toISOString(),
    },
  })
}

// =============================================================================
// Delivery Status Handler (T048)
// =============================================================================

/**
 * Update message delivery status in inbox
 */
export async function handleDeliveryStatus(
  payload: StatusUpdatePayload
): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    console.error('[Inbox] Supabase admin client not available')
    return false
  }

  // Find message by WhatsApp message ID
  const { data: message, error } = await supabase
    .from('inbox_messages')
    .select('id, conversation_id, delivery_status')
    .eq('whatsapp_message_id', payload.messageId)
    .single()

  if (error || !message) {
    // Message not found in inbox - might be from campaigns
    return false
  }

  // Update delivery status
  const updates: Record<string, unknown> = {
    delivery_status: payload.status,
  }

  // Add timestamp fields
  if (payload.status === 'delivered') {
    updates.delivered_at = payload.timestamp || new Date().toISOString()
  } else if (payload.status === 'read') {
    updates.read_at = payload.timestamp || new Date().toISOString()
  } else if (payload.status === 'failed') {
    updates.failed_at = payload.timestamp || new Date().toISOString()
    if (payload.errors?.[0]) {
      updates.failure_reason = `[${payload.errors[0].code}] ${payload.errors[0].title}`
    }
  }

  const { error: updateError } = await supabase
    .from('inbox_messages')
    .update(updates)
    .eq('id', message.id)

  if (updateError) {
    console.error('[Inbox] Failed to update delivery status:', updateError)
    return false
  }

  return true
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Find contact ID by phone number
 */
async function findContactId(phone: string): Promise<string | null> {
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    console.error('[Inbox] Supabase admin client not available')
    return null
  }

  const { data } = await supabase
    .from('contacts')
    .select('id')
    .eq('phone', phone)
    .single()

  return data?.id || null
}

/**
 * Map WhatsApp message types to inbox message types
 */
function mapMessageType(waType: string): InboxMessage['message_type'] {
  const typeMap: Record<string, InboxMessage['message_type']> = {
    text: 'text',
    image: 'image',
    audio: 'audio',
    video: 'video',
    document: 'document',
    template: 'template',
    interactive: 'interactive',
    button: 'interactive',
    location: 'text',
    contacts: 'text',
    sticker: 'image',
  }

  return typeMap[waType] || 'text'
}

/**
 * T066: Check if automation is paused for a conversation
 * Returns true if pause timestamp exists and is in the future
 */
function isAutomationPaused(pausedUntil: string | null | undefined): boolean {
  if (!pausedUntil) return false
  const pauseTime = new Date(pausedUntil).getTime()
  const now = Date.now()
  return pauseTime > now
}
