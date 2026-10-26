// @vitest-environment node
/**
 * Testes de integração do /api/ai/respond com Redis/QStash/DB simulados.
 *
 * Cenário principal: usuário manda 6 mensagens rápidas ("oi"); o webhook agenda
 * 6 jobs; os jobs executam fora de ordem e com jitter. Esperado: UMA chamada à IA
 * contendo TODAS as mensagens e UMA resposta enviada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIAgent, InboxConversation, InboxMessage } from '@/types'

const { fakeRedis, mocks } = await vi.hoisted(async () => {
  const { FakeRedis } = await import('@/tests/helpers/fake-redis')
  return {
    fakeRedis: new FakeRedis(),
    mocks: {
      getConversation: vi.fn(),
      listMessages: vi.fn(),
      createMessage: vi.fn(),
      updateConversation: vi.fn(),
      processChatAgent: vi.fn(),
      sendWhatsAppMessage: vi.fn(),
      sendTypingIndicator: vi.fn(),
      dispatchAIRespondJob: vi.fn(),
      supabase: { current: null as unknown },
    },
  }
})

vi.mock('@/lib/redis', () => ({ redis: fakeRedis, isRedisConfigured: () => true }))
vi.mock('@/lib/qstash-request-auth', () => ({
  verifyQStashOrApiKey: vi.fn().mockResolvedValue({ valid: true, keyType: 'api' }),
}))
vi.mock('@/lib/auth', () => ({
  unauthorizedResponse: (error?: string) => new Response(JSON.stringify({ error }), { status: 401 }),
}))
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mocks.supabase.current }))
vi.mock('@/lib/inbox/inbox-db', () => ({
  inboxDb: {
    getConversation: mocks.getConversation,
    listMessages: mocks.listMessages,
    createMessage: mocks.createMessage,
    updateConversation: mocks.updateConversation,
  },
}))
vi.mock('@/lib/ai/agents/chat-agent', () => ({ processChatAgent: mocks.processChatAgent }))
vi.mock('@/lib/whatsapp-send', () => ({
  sendWhatsAppMessage: mocks.sendWhatsAppMessage,
  sendTypingIndicator: mocks.sendTypingIndicator,
}))
vi.mock('@/lib/inbox/ai-dispatch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inbox/ai-dispatch')>('@/lib/inbox/ai-dispatch')
  return { ...actual, dispatchAIRespondJob: mocks.dispatchAIRespondJob }
})

import { createFakeSupabase } from '@/tests/helpers/fake-supabase-query'
import { markLatestInboundMessage } from '@/lib/inbox/ai-debounce'
import { POST } from './route'

// =============================================================================
// Fixtures
// =============================================================================

const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'
const DEBOUNCE_MS = 5000

const agent: AIAgent = {
  id: 'agent-1',
  name: 'Agente Teste',
  system_prompt: 'Você é um assistente.',
  model: 'gemini-2.5-flash',
  temperature: 0.7,
  max_tokens: 1024,
  is_active: true,
  is_default: true,
  debounce_ms: DEBOUNCE_MS,
  embedding_provider: null,
  embedding_model: null,
  embedding_dimensions: null,
  rerank_enabled: null,
  rerank_provider: null,
  rerank_model: null,
  rerank_top_k: null,
  rag_similarity_threshold: null,
  rag_max_results: null,
  handoff_enabled: false,
  handoff_instructions: null,
  booking_tool_enabled: false,
  allow_reactions: false,
  allow_quotes: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const conversation = {
  id: CONVERSATION_ID,
  phone: '+5511999999999',
  contact_id: null,
  mode: 'bot',
  status: 'open',
  ai_agent_id: agent.id,
  human_mode_expires_at: null,
  automation_paused_until: null,
} as unknown as InboxConversation

/** "Banco" em memória de mensagens da conversa (ordem cronológica) */
let dbMessages: InboxMessage[] = []
let outboundCounter = 0

function addInbound(i: number, content = 'oi'): InboxMessage {
  const message = {
    id: `m${i}`,
    conversation_id: CONVERSATION_ID,
    direction: 'inbound',
    content,
    message_type: 'text',
    media_url: null,
    whatsapp_message_id: `wamid.${i}`,
    delivery_status: 'delivered',
    ai_response_id: null,
    ai_sentiment: null,
    ai_sources: null,
    payload: null,
    created_at: new Date(Date.now() + i).toISOString(),
  } as InboxMessage
  dbMessages.push(message)
  return message
}

/** Simula o que o webhook faz ao receber a mensagem i (persistir + marcar como mais recente) */
async function receiveInbound(i: number, at: number) {
  addInbound(i)
  await markLatestInboundMessage(CONVERSATION_ID, `wamid.${i}`, 300, at)
}

function jobRequest(messageId: string, extra: Record<string, unknown> = {}) {
  return new Request('http://localhost:3000/api/ai/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({ conversationId: CONVERSATION_ID, debounceMs: DEBOUNCE_MS, messageId, ...extra }),
  })
}

async function runJob(messageId: string, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await POST(jobRequest(messageId, extra) as any)
  return { status: response.status, body: await response.json() }
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// =============================================================================
// Setup
// =============================================================================

describe('POST /api/ai/respond — burst de mensagens', () => {
  beforeEach(() => {
    fakeRedis.clear()
    dbMessages = []
    outboundCounter = 0

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Encurta os delays de "digitando" (setTimeout) para o teste rodar rápido
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(fn, Math.min(ms ?? 0, 5))) as typeof setTimeout)

    mocks.supabase.current = createFakeSupabase({
      tables: {
        ai_agents: () => ({ data: agent, error: null }),
      },
    })

    mocks.getConversation.mockReset().mockResolvedValue(conversation)
    mocks.listMessages.mockReset().mockImplementation(async (_id: string, opts?: { limit?: number }) => {
      const limit = opts?.limit ?? 20
      const snapshot = [...dbMessages]
      return { messages: snapshot.slice(-limit), hasMore: snapshot.length > limit }
    })
    mocks.createMessage.mockReset().mockImplementation(async (dto: Partial<InboxMessage>) => {
      outboundCounter++
      const message = {
        id: `out-${outboundCounter}`,
        ai_response_id: null,
        ai_sentiment: null,
        ai_sources: null,
        media_url: null,
        payload: null,
        created_at: new Date().toISOString(),
        ...dto,
      } as InboxMessage
      dbMessages.push(message)
      return message
    })
    mocks.updateConversation.mockReset().mockResolvedValue(conversation)
    mocks.processChatAgent.mockReset().mockImplementation(async () => {
      await sleep(20) // simula latência do modelo
      return {
        success: true,
        response: { message: 'Olá! Como posso ajudar?', sentiment: 'neutral', shouldHandoff: false },
        latencyMs: 20,
        logId: 'log-1',
      }
    })
    mocks.sendWhatsAppMessage.mockReset().mockImplementation(async () => ({
      success: true,
      messageId: `wamid.out.${Math.random().toString(36).slice(2, 8)}`,
    }))
    mocks.sendTypingIndicator.mockReset().mockResolvedValue({ success: true })
    mocks.dispatchAIRespondJob.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ===========================================================================

  it('6 mensagens rápidas → exatamente UMA chamada à IA, com TODAS as mensagens, e UMA resposta', async () => {
    const base = Date.now() - 20_000
    for (let i = 1; i <= 6; i++) {
      await receiveInbound(i, base + i * 400) // 6x "oi" em ~2,4s
    }

    // Jobs executam fora de ordem e com jitter (QStash não garante ordem)
    const order = shuffle([1, 2, 3, 4, 5, 6])
    const results = await Promise.all(
      order.map(async (i) => {
        await sleep(Math.floor(Math.random() * 30))
        return { i, ...(await runJob(`wamid.${i}`)) }
      })
    )

    const processed = results.filter((r) => r.body.success === true && !r.body.deduplicated)
    const superseded = results.filter((r) => r.body.reason === 'superseded')

    expect(processed).toHaveLength(1)
    expect(processed[0].i).toBe(6) // só o job da mensagem MAIS RECENTE responde
    expect(processed[0].body.answeredMessages).toBe(6)
    expect(superseded).toHaveLength(5)
    expect(results.every((r) => r.status === 200)).toBe(true)

    // IA chamada UMA vez, com as 6 mensagens do usuário
    expect(mocks.processChatAgent).toHaveBeenCalledTimes(1)
    const aiInput = mocks.processChatAgent.mock.calls[0][0]
    const inboundIds = aiInput.messages.filter((m: InboxMessage) => m.direction === 'inbound').map((m: InboxMessage) => m.id)
    expect(inboundIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])

    // UMA resposta enviada ao WhatsApp, com typing indicator na última mensagem do usuário
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendTypingIndicator).toHaveBeenCalledWith({ messageId: 'wamid.6' })

    // Estado final no Redis: lock liberado, marcador NÃO apagado, última respondida = m6
    expect(fakeRedis.has(`ai:lock:${CONVERSATION_ID}`)).toBe(false)
    expect(fakeRedis.peek<{ messageId: string }>(`ai:lastmsg:${CONVERSATION_ID}`)?.messageId).toBe('wamid.6')
    expect(fakeRedis.peek(`ai:lastanswered:${CONVERSATION_ID}`)).toBe('m6')
    expect(mocks.dispatchAIRespondJob).not.toHaveBeenCalled()
  })

  it('jobs atrasados que chegam DEPOIS da resposta não geram segunda resposta', async () => {
    const base = Date.now() - 20_000
    for (let i = 1; i <= 6; i++) await receiveInbound(i, base + i * 400)

    const first = await runJob('wamid.6')
    expect(first.body.success).toBe(true)

    // Jobs 1..5 chegam atrasados (ex.: QStash com atraso) e o job 6 é reentregue (retry)
    for (const i of [3, 1, 5, 2, 4]) {
      const late = await runJob(`wamid.${i}`)
      expect(late.body.reason).toBe('superseded')
    }
    const retry = await runJob('wamid.6')
    expect(retry.body.deduplicated).toBe(true)

    expect(mocks.processChatAgent).toHaveBeenCalledTimes(1)
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(1)
  })

  it('ainda dentro da janela de debounce: job da última mensagem espera (user-still-typing)', async () => {
    await receiveInbound(1, Date.now() - 1000) // há 1s, debounce de 5s

    const result = await runJob('wamid.1')

    expect(result.body).toEqual({ skipped: true, reason: 'user-still-typing' })
    expect(mocks.processChatAgent).not.toHaveBeenCalled()
    expect(fakeRedis.has(`ai:lastmsg:${CONVERSATION_ID}`)).toBe(true) // marcador preservado
  })

  it('mensagem chega DURANTE a geração: o job novo é reagendado e depois responde só o que ficou pendente', async () => {
    const base = Date.now() - 20_000
    for (let i = 1; i <= 6; i++) await receiveInbound(i, base + i * 400)

    // Deixa a IA "pensando" até liberarmos
    let releaseAI!: () => void
    const aiGate = new Promise<void>((resolve) => (releaseAI = resolve))
    mocks.processChatAgent.mockImplementation(async () => {
      await aiGate
      return {
        success: true,
        response: { message: 'Resposta às 6 mensagens', sentiment: 'neutral', shouldHandoff: false },
        latencyMs: 1,
        logId: 'log-1',
      }
    })

    const job6 = runJob('wamid.6')
    await sleep(10) // job 6 já pegou o lock e está gerando

    // Mensagem 7 chega enquanto a IA gera → webhook marca como mais recente
    await receiveInbound(7, Date.now() - 10_000)
    const job7 = await runJob('wamid.7')

    expect(job7.body).toMatchObject({ skipped: true, reason: 'conversation-busy', rescheduled: true, attempt: 1 })
    expect(mocks.dispatchAIRespondJob).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchAIRespondJob).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION_ID, messageId: 'wamid.7', attempt: 1 })
    )

    releaseAI()
    const job6Result = await job6
    expect(job6Result.body.success).toBe(true)
    expect(job6Result.body.answeredMessages).toBe(6)

    // Job reagendado da mensagem 7 roda depois que o lock foi liberado
    mocks.processChatAgent.mockImplementation(async () => ({
      success: true,
      response: { message: 'Resposta à mensagem 7', sentiment: 'neutral', shouldHandoff: false },
      latencyMs: 1,
      logId: 'log-2',
    }))
    const job7Retry = await runJob('wamid.7', { attempt: 1 })

    expect(job7Retry.body.success).toBe(true)
    expect(job7Retry.body.answeredMessages).toBe(1) // só a m7 estava pendente

    // Duas gerações distintas (6 msgs, depois 1 msg) — nenhuma duplicada
    expect(mocks.processChatAgent).toHaveBeenCalledTimes(2)
    // No banco a ordem é [m1..m6, m7, out-1]: a m7 chegou ANTES da 1ª resposta ser salva.
    // A heurística "inbound após a última outbound" deixaria a m7 sem resposta; o marcador
    // ai:lastanswered (= m6) é o que garante que ela seja respondida. Para a IA, a m7
    // é reposicionada DEPOIS da resposta anterior (vez atual do usuário).
    expect(dbMessages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'out-1', 'out-2'])
    const secondCallMessages = mocks.processChatAgent.mock.calls[1][0].messages as InboxMessage[]
    expect(secondCallMessages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'out-1', 'm7'])
    expect(fakeRedis.peek(`ai:lastanswered:${CONVERSATION_ID}`)).toBe('m7')
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(2)
    expect(fakeRedis.has(`ai:lock:${CONVERSATION_ID}`)).toBe(false)
  })

  it('job reagendado que roda quando tudo já foi respondido não responde de novo', async () => {
    const base = Date.now() - 20_000
    for (let i = 1; i <= 6; i++) await receiveInbound(i, base + i * 400)

    await runJob('wamid.6')
    expect(mocks.processChatAgent).toHaveBeenCalledTimes(1)

    // Reentrega artificial do mesmo messageId com outro attempt (dedup por mensagem já segura)
    const retry = await runJob('wamid.6', { attempt: 1 })
    expect(retry.body.deduplicated).toBe(true)

    // Cenário sem dedup por mensagem (ex.: TTL expirou): o lock/pending segura
    await fakeRedis.del('ai:processed:wamid.6')
    const stale = await runJob('wamid.6', { attempt: 2 })
    expect(stale.body).toEqual({ skipped: true, reason: 'no-pending-inbound' })

    expect(mocks.processChatAgent).toHaveBeenCalledTimes(1)
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(1)
  })

  it('não consegue reagendar (QStash fora): devolve 503 para o QStash tentar de novo', async () => {
    const base = Date.now() - 20_000
    for (let i = 1; i <= 2; i++) await receiveInbound(i, base + i * 400)
    mocks.dispatchAIRespondJob.mockResolvedValue(false)

    // Simula lock ocupado por outro job
    await fakeRedis.set(`ai:lock:${CONVERSATION_ID}`, 'wamid.1', { nx: true, ex: 60 })

    const result = await runJob('wamid.2')
    expect(result.status).toBe(503)
    expect(result.body.reason).toBe('conversation-busy')
    expect(mocks.processChatAgent).not.toHaveBeenCalled()
  })

  it('Redis fora do ar: processa mesmo assim (fail-open) e não quebra', async () => {
    addInbound(1)
    fakeRedis.failing = true

    const result = await runJob('wamid.1')

    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(mocks.processChatAgent).toHaveBeenCalledTimes(1)
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(1)
  })

  it('resposta com parágrafos continua sendo dividida em várias mensagens (split preservado)', async () => {
    const base = Date.now() - 20_000
    await receiveInbound(1, base)
    mocks.processChatAgent.mockImplementation(async () => ({
      success: true,
      response: { message: 'Parte 1\n\nParte 2\n\nParte 3', sentiment: 'positive', shouldHandoff: false },
      latencyMs: 1,
      logId: 'log-1',
    }))

    const result = await runJob('wamid.1')

    expect(result.body.success).toBe(true)
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(3)
    expect(mocks.sendTypingIndicator).toHaveBeenCalledTimes(3)
    expect(mocks.sendWhatsAppMessage.mock.calls.map((c) => c[0].text)).toEqual(['Parte 1', 'Parte 2', 'Parte 3'])
  })
})
