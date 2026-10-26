// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { fakeRedis, publishJSON, supabaseRef } = await vi.hoisted(async () => {
  const { FakeRedis } = await import('@/tests/helpers/fake-redis')
  return {
    fakeRedis: new FakeRedis(),
    publishJSON: vi.fn(),
    supabaseRef: { current: null as unknown },
  }
})

vi.mock('@/lib/redis', () => ({ redis: fakeRedis, isRedisConfigured: () => true }))
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => supabaseRef.current }))
vi.mock('@upstash/qstash', () => ({
  Client: class {
    publishJSON = publishJSON
  },
}))
vi.mock('@/lib/ai/agents/chat-agent', () => ({ cancelDebounce: vi.fn() }))
vi.mock('@/lib/whatsapp-send', () => ({ sendWhatsAppMessage: vi.fn() }))
vi.mock('./inbox-db', () => ({
  inboxDb: { createConversation: vi.fn(), updateConversation: vi.fn(), createMessage: vi.fn() },
  isHumanModeExpired: vi.fn(() => false),
  switchToBotMode: vi.fn(),
  findConversationByPhoneLightweight: vi.fn(),
}))

import { createFakeSupabase, type FakeQuery } from '@/tests/helpers/fake-supabase-query'
import { handleInboundMessage } from './inbox-webhook'

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = 'agent-default'
const AGENT_DEBOUNCE_MS = 8000

interface Scenario {
  /** ai_agent_id que a RPC process_inbound_message devolve (null = conversa nova sem agente) */
  rpcAgentId: string | null
  isNew?: boolean
}

function setupSupabase(scenario: Scenario) {
  let messageCounter = 0
  const conversationUpdates: FakeQuery[] = []

  const supabase = createFakeSupabase({
    rpc: {
      process_inbound_message: () => {
        messageCounter++
        return {
          data: {
            conversation_id: CONVERSATION_ID,
            message_id: `msg-${messageCounter}`,
            is_new_conversation: scenario.isNew ?? messageCounter === 1,
            conversation_status: 'open',
            conversation_mode: 'bot',
            ai_agent_id: scenario.rpcAgentId,
            human_mode_expires_at: null,
            automation_paused_until: null,
          },
          error: null,
        }
      },
      // Simula o comportamento real do SQL: conversa sem agente → COALESCE(NULL, 3000)
      get_agent_config: () => ({
        data: { ai_agent_id: scenario.rpcAgentId, debounce_ms: scenario.rpcAgentId ? AGENT_DEBOUNCE_MS : 3000, agent_name: null },
        error: null,
      }),
    },
    tables: {
      ai_agents: ({ filters, columns }) => {
        const byId = filters.find((f) => f.type === 'eq' && f.column === 'id')
        if (byId) {
          return byId.value === AGENT_ID
            ? { data: columns === 'id' ? { id: AGENT_ID } : { debounce_ms: AGENT_DEBOUNCE_MS }, error: null }
            : { data: null, error: null }
        }
        // agente padrão ativo
        return { data: columns === 'id' ? { id: AGENT_ID } : { debounce_ms: AGENT_DEBOUNCE_MS }, error: null }
      },
      inbox_conversations: (query) => {
        if (query.op === 'update') conversationUpdates.push(query)
        return { data: null, error: null }
      },
    },
  })

  supabaseRef.current = supabase
  return { supabase, conversationUpdates }
}

function inbound(i: number) {
  return {
    messageId: `wamid.${i}`,
    from: '5511999999999',
    type: 'text',
    text: 'oi',
    timestamp: String(1_700_000_000 + i),
    phoneNumberId: '123456',
  }
}

describe('handleInboundMessage → triggerAIProcessing', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, QSTASH_TOKEN: 'qstash-test-token', NEXT_PUBLIC_APP_URL: 'https://preview.example.com' }
    fakeRedis.clear()
    publishJSON.mockReset().mockResolvedValue({ messageId: 'qstash-1' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    vi.restoreAllMocks()
  })

  it('conversa nova sem agente: vincula o agente padrão e usa o debounce_ms DELE (não o fallback 3000)', async () => {
    const { supabase, conversationUpdates } = setupSupabase({ rpcAgentId: null, isNew: true })

    const result = await handleInboundMessage(inbound(1))

    expect(result).toEqual({ conversationId: CONVERSATION_ID, messageId: 'msg-1', triggeredAI: true })

    // Vinculou o agente padrão à conversa (somente se ainda estiver nulo)
    expect(conversationUpdates).toHaveLength(1)
    expect(conversationUpdates[0].payload).toEqual({ ai_agent_id: AGENT_ID })
    expect(conversationUpdates[0].filters).toEqual(
      expect.arrayContaining([
        { type: 'eq', column: 'id', value: CONVERSATION_ID },
        { type: 'is', column: 'ai_agent_id', value: null },
      ])
    )

    // Não dependeu da RPC get_agent_config (que devolveria o fallback 3000)
    expect(supabase.rpcCalls.map((c) => c.name)).not.toContain('get_agent_config')

    // Job agendado com o debounce do agente (8s), não 3s nem 5s
    expect(publishJSON).toHaveBeenCalledTimes(1)
    const call = publishJSON.mock.calls[0][0]
    expect(call.url).toBe('https://preview.example.com/api/ai/respond')
    expect(call.delay).toBe(AGENT_DEBOUNCE_MS / 1000)
    expect(call.body).toEqual({ conversationId: CONVERSATION_ID, debounceMs: AGENT_DEBOUNCE_MS, messageId: 'wamid.1' })
    expect(call.deduplicationId).toBe('ai_respond_wamid_1')
    expect(call.headers.Authorization).toBeUndefined()

    // Marcador de debounce com a mensagem mais recente
    const state = fakeRedis.peek<{ ts: number; messageId: string }>(`ai:lastmsg:${CONVERSATION_ID}`)
    expect(state?.messageId).toBe('wamid.1')
    expect(typeof state?.ts).toBe('number')
  })

  it('conversa já vinculada: não tenta vincular de novo e usa o debounce do agente', async () => {
    const { conversationUpdates } = setupSupabase({ rpcAgentId: AGENT_ID })

    await handleInboundMessage(inbound(1))

    expect(conversationUpdates).toHaveLength(0)
    expect(publishJSON.mock.calls[0][0].body.debounceMs).toBe(AGENT_DEBOUNCE_MS)
  })

  it('burst de 6 mensagens: agenda 6 jobs (um por mensagem) e o marcador aponta para a ÚLTIMA', async () => {
    setupSupabase({ rpcAgentId: AGENT_ID })

    for (let i = 1; i <= 6; i++) {
      await handleInboundMessage(inbound(i))
    }

    expect(publishJSON).toHaveBeenCalledTimes(6)
    const dedupIds = publishJSON.mock.calls.map((c) => c[0].deduplicationId)
    expect(new Set(dedupIds).size).toBe(6)

    const state = fakeRedis.peek<{ ts: number; messageId: string }>(`ai:lastmsg:${CONVERSATION_ID}`)
    expect(state?.messageId).toBe('wamid.6')
  })

  it('debounce desabilitado (0): dispara imediatamente, mas ainda registra a mensagem mais recente', async () => {
    const supabase = createFakeSupabase({
      rpc: {
        process_inbound_message: () => ({
          data: {
            conversation_id: CONVERSATION_ID,
            message_id: 'msg-1',
            is_new_conversation: false,
            conversation_status: 'open',
            conversation_mode: 'bot',
            ai_agent_id: AGENT_ID,
            human_mode_expires_at: null,
            automation_paused_until: null,
          },
          error: null,
        }),
      },
      tables: {
        ai_agents: () => ({ data: { debounce_ms: 0 }, error: null }),
      },
    })
    supabaseRef.current = supabase

    await handleInboundMessage(inbound(1))

    const call = publishJSON.mock.calls[0][0]
    expect(call.delay).toBeUndefined()
    expect(call.body.debounceMs).toBe(0)
    expect(fakeRedis.peek<{ messageId: string }>(`ai:lastmsg:${CONVERSATION_ID}`)?.messageId).toBe('wamid.1')
  })

  it('Redis fora do ar: ainda agenda o job (fail-open)', async () => {
    setupSupabase({ rpcAgentId: AGENT_ID })
    fakeRedis.failing = true

    const result = await handleInboundMessage(inbound(1))

    expect(result.triggeredAI).toBe(true)
    expect(publishJSON).toHaveBeenCalledTimes(1)
  })

  it('sem QSTASH_TOKEN: não dispara IA', async () => {
    setupSupabase({ rpcAgentId: AGENT_ID })
    delete process.env.QSTASH_TOKEN

    const result = await handleInboundMessage(inbound(1))

    expect(result.triggeredAI).toBe(false)
    expect(publishJSON).not.toHaveBeenCalled()
  })
})
