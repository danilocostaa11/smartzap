// @vitest-environment node
/**
 * Testes do chat-agent focados em robustez da chamada ao modelo:
 *
 * 1. Guard de prefill: histórico que termina em mensagem do assistente (job duplicado
 *    rodando depois que a resposta já saiu) → IA NÃO é chamada, sem handoff.
 * 2. Retry com backoff para erros TRANSITÓRIOS (5xx, 429, timeout, rede, prefill após
 *    reconstruir o histórico): até 2 tentativas extras (~1s, ~3s). Só depois disso o
 *    resultado vira erro (que a rota transforma em auto-handoff). Erros de auth/config
 *    (401/403/400) não são repetidos.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import type { AIAgent, InboxConversation, InboxMessage } from '@/types'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    generateText: vi.fn(),
    logInserts: [] as unknown[],
  },
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  // `tool()` só precisa devolver a definição: o mock de generateText chama `execute` direto
  tool: (definition: unknown) => definition,
  stepCountIs: () => () => false,
}))
vi.mock('@/lib/redis', () => ({ redis: null, isRedisConfigured: () => false }))
vi.mock('@/lib/ai/devtools', () => ({ withDevTools: async (model: unknown) => model }))
vi.mock('@/lib/ai/rag-store', () => ({
  findRelevantContent: vi.fn(),
  hasIndexedContent: vi.fn().mockResolvedValue(false),
  buildEmbeddingConfigFromAgent: vi.fn(),
  buildRerankConfigFromAgent: vi.fn(),
  resolveEmbeddingApiKeyForAgent: vi.fn(),
}))
vi.mock('@/lib/ai/mem0-client', () => ({
  isMem0EnabledAsync: vi.fn().mockResolvedValue(false),
  fetchRelevantMemories: vi.fn(),
  saveInteractionMemory: vi.fn(),
}))
vi.mock('@/lib/ai/ai-center-config', () => ({
  getAiDirectConfig: vi.fn().mockResolvedValue({
    provider: 'opencode_go',
    model: 'claude-haiku-5-5',
    googleApiKey: null,
    openaiApiKey: null,
    opencodeGoApiKey: 'ocg-test-key',
  }),
}))
vi.mock('@/lib/ai/direct-model', () => ({
  createDirectModel: vi.fn().mockResolvedValue({
    model: { modelId: 'claude-haiku-5-5' },
    modelId: 'claude-haiku-5-5',
    provider: 'opencode_go',
  }),
}))
vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      insert: (payload: unknown) => {
        mocks.logInserts.push(payload)
        return { select: () => ({ single: async () => ({ data: { id: 'log-1' }, error: null }) }) }
      },
    }),
  }),
}))

import { processChatAgent, MODEL_RETRY_DELAYS_MS } from './chat-agent'

// =============================================================================
// Fixtures
// =============================================================================

const agent: AIAgent = {
  id: 'agent-1',
  name: 'Agente Teste',
  system_prompt: 'Você é um assistente.',
  model: 'claude-haiku-5-5',
  temperature: 0.7,
  max_tokens: 1024,
  is_active: true,
  is_default: true,
  debounce_ms: 5000,
  embedding_provider: null,
  embedding_model: null,
  embedding_dimensions: null,
  rerank_enabled: null,
  rerank_provider: null,
  rerank_model: null,
  rerank_top_k: null,
  rag_similarity_threshold: null,
  rag_max_results: null,
  handoff_enabled: true,
  handoff_instructions: null,
  booking_tool_enabled: false,
  allow_reactions: false,
  allow_quotes: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const conversation = {
  id: '22222222-2222-4222-8222-222222222222',
  phone: '+5511999999999',
  contact_id: null,
  mode: 'bot',
  status: 'open',
  ai_agent_id: agent.id,
  automation_paused_until: null,
} as unknown as InboxConversation

function msg(id: string, direction: 'inbound' | 'outbound', content: string): InboxMessage {
  return {
    id,
    conversation_id: conversation.id,
    direction,
    content,
    message_type: 'text',
    media_url: null,
    whatsapp_message_id: direction === 'inbound' ? `wamid.${id}` : null,
    delivery_status: 'delivered',
    ai_response_id: null,
    ai_sentiment: null,
    ai_sources: null,
    payload: null,
    created_at: new Date().toISOString(),
  } as InboxMessage
}

/** Histórico com turno do usuário pendente (caso normal). */
const pendingHistory = [msg('m1', 'inbound', 'oi'), msg('o1', 'outbound', 'Olá!'), msg('m2', 'inbound', 'qual o preço?')]
/** Histórico em que o bot já respondeu por último (job duplicado/atrasado). */
const answeredHistory = [msg('m1', 'inbound', 'oi'), msg('o1', 'outbound', 'Olá! Como posso ajudar?')]

const PREFILL_BODY =
  '{"type":"error","error":{"type":"invalid_request_error","message":"assistant message prefill is not supported for this model"}}'

function apiError(statusCode: number, body: string, message = `HTTP ${statusCode}`) {
  return new APICallError({
    message,
    url: 'https://opencode.ai/zen/go/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
  })
}

type GenerateArgs = {
  messages: Array<{ role: string; content: string }>
  tools: { respond: { execute: (params: Record<string, unknown>) => Promise<unknown> } }
  abortSignal: AbortSignal
  maxRetries?: number
}

/** Simula o LLM chamando a tool `respond` e devolvendo um resultado de generateText. */
async function respondOk(args: GenerateArgs, message = 'Custa R$ 10.') {
  await args.tools.respond.execute({ message, sentiment: 'neutral', confidence: 0.9, shouldHandoff: false })
  return { text: '', steps: [], finishReason: 'tool-calls', response: {}, warnings: [], usage: {} }
}

/** Simula uma chamada pendurada que só termina quando o nosso timeout aborta. */
function hangUntilAborted(args: GenerateArgs) {
  return new Promise((_, reject) => {
    args.abortSignal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })
}

/** Delays pedidos ao setTimeout (para conferir o backoff) */
let requestedDelays: number[] = []

describe('processChatAgent — guard de prefill', () => {
  beforeEach(() => {
    mocks.generateText.mockReset()
    mocks.logInserts.length = 0
    requestedDelays = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Encurta todos os timers (backoff e timeout de 90s) para o teste rodar rápido,
    // registrando o delay pedido para conferir a política de backoff.
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      requestedDelays.push(ms ?? 0)
      return realSetTimeout(fn, Math.min(ms ?? 0, 5))
    }) as typeof setTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('histórico termina com mensagem do assistente → NÃO chama o modelo, sem handoff, sem erro', async () => {
    const result = await processChatAgent({ agent, conversation, messages: answeredHistory })

    expect(result).toMatchObject({ success: true, skipped: true, skipReason: 'no-pending-user-message' })
    expect(result.response).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.logInserts).toHaveLength(0) // não registra erro no ai_agent_logs
  })

  it('histórico vazio ou só com notas internas também é pulado', async () => {
    expect(await processChatAgent({ agent, conversation, messages: [] })).toMatchObject({ skipped: true })
    const note = { ...msg('n1', 'outbound', 'nota'), message_type: 'internal_note' } as InboxMessage
    expect(await processChatAgent({ agent, conversation, messages: [note] })).toMatchObject({ skipped: true })
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  it('com turno do usuário pendente, o histórico enviado SEMPRE termina em user', async () => {
    mocks.generateText.mockImplementation(respondOk)

    // Último "turno" do banco: resposta do bot seguida de nota interna e de uma pergunta nova
    const history = [
      msg('m1', 'inbound', 'oi'),
      msg('o1', 'outbound', 'Olá!'),
      msg('m2', 'inbound', 'qual o preço?'),
      msg('o2', 'outbound', 'R$ 10'),
      msg('m3', 'inbound', 'e o prazo?'),
    ]
    const result = await processChatAgent({ agent, conversation, messages: history })

    expect(result.success).toBe(true)
    expect(result.response?.message).toBe('Custa R$ 10.')
    const sent = mocks.generateText.mock.calls[0][0] as GenerateArgs
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'e o prazo?' })
    expect(sent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    // Retry é responsabilidade do chat-agent, não do AI SDK
    expect(sent.maxRetries).toBe(0)
  })

  it('bot respondeu por último em várias partes (split) → pulado mesmo havendo user antes', async () => {
    mocks.generateText.mockImplementation(respondOk)

    const history = [...pendingHistory, msg('o2', 'outbound', 'Parte 1'), msg('o3', 'outbound', 'Parte 2')]
    const result = await processChatAgent({ agent, conversation, messages: history })

    expect(result).toMatchObject({ skipped: true, skipReason: 'no-pending-user-message' })
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  it('nota interna depois da resposta do bot não conta como turno do usuário', async () => {
    const note = { ...msg('n1', 'outbound', 'Transferência'), message_type: 'internal_note' } as InboxMessage
    const result = await processChatAgent({ agent, conversation, messages: [...answeredHistory, note] })

    expect(result).toMatchObject({ skipped: true })
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})

describe('processChatAgent — retry em erros transitórios do modelo', () => {
  beforeEach(() => {
    mocks.generateText.mockReset()
    mocks.logInserts.length = 0
    requestedDelays = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      requestedDelays.push(ms ?? 0)
      return realSetTimeout(fn, Math.min(ms ?? 0, 5))
    }) as typeof setTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('503 na primeira tentativa → espera ~1s e responde na segunda (sem handoff)', async () => {
    mocks.generateText
      .mockRejectedValueOnce(apiError(503, '{"error":"upstream request failed"}', 'Service Unavailable'))
      .mockImplementationOnce(respondOk)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(result.response?.message).toBe('Custa R$ 10.')
    expect(result.response?.shouldHandoff).toBe(false)
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    expect(requestedDelays).toContain(MODEL_RETRY_DELAYS_MS[0]) // backoff de 1s
    expect(requestedDelays).not.toContain(MODEL_RETRY_DELAYS_MS[1])
  })

  it('429 duas vezes → backoff 1s e depois 3s; responde na terceira', async () => {
    mocks.generateText
      .mockRejectedValueOnce(apiError(429, '{"error":"rate limited"}', 'Too Many Requests'))
      .mockRejectedValueOnce(apiError(429, '{"error":"rate limited"}', 'Too Many Requests'))
      .mockImplementationOnce(respondOk)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(mocks.generateText).toHaveBeenCalledTimes(3)
    const backoffs = requestedDelays.filter((d) => (MODEL_RETRY_DELAYS_MS as readonly number[]).includes(d))
    expect(backoffs).toEqual([1000, 3000])
  })

  it('erro transitório persistente → esgota os 2 retries e só então devolve erro (handoff pela rota)', async () => {
    mocks.generateText.mockRejectedValue(apiError(502, 'bad gateway', 'Bad Gateway'))

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(mocks.generateText).toHaveBeenCalledTimes(3) // 1 + 2 retries
    expect(result.success).toBe(false)
    expect(result.skipped).toBeUndefined()
    expect(result.error).toContain('Bad Gateway')
    // Comportamento existente preservado: resposta de fallback com shouldHandoff para a rota
    expect(result.response?.shouldHandoff).toBe(true)
    expect(result.response?.handoffReason).toContain('Erro técnico')
    expect(mocks.logInserts).toHaveLength(1)
  })

  it('timeout da chamada é transitório: aborta, tenta de novo e responde', async () => {
    mocks.generateText.mockImplementationOnce(hangUntilAborted).mockImplementationOnce(respondOk)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    expect(requestedDelays).toContain(1000)
  })

  it('timeout persistente → erro "AI call timed out" após esgotar os retries', async () => {
    mocks.generateText.mockImplementation(hangUntilAborted)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(mocks.generateText).toHaveBeenCalledTimes(3)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  })

  it('erro de rede (fetch failed / ECONNRESET) é transitório', async () => {
    const fetchFailed = new TypeError('fetch failed')
    ;(fetchFailed as Error & { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    mocks.generateText.mockRejectedValueOnce(fetchFailed).mockImplementationOnce(respondOk)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
  })

  it('401 (chave inválida) NÃO é repetido: falha na primeira e vira erro', async () => {
    mocks.generateText.mockRejectedValue(apiError(401, '{"error":"invalid api key"}', 'Unauthorized'))

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(mocks.generateText).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unauthorized')
    expect(requestedDelays).not.toContain(1000)
  })

  it.each([400, 403, 404, 422])('%i (config/validação) NÃO é repetido', async (status) => {
    mocks.generateText.mockRejectedValue(apiError(status, '{"error":"nope"}'))

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(mocks.generateText).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
  })

  it('prefill (400) → reconstrói o histórico terminando em user e tenta de novo', async () => {
    mocks.generateText
      .mockRejectedValueOnce(apiError(400, PREFILL_BODY, 'Bad Request'))
      .mockImplementationOnce(respondOk)

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    const retried = mocks.generateText.mock.calls[1][0] as GenerateArgs
    expect(retried.messages.at(-1)?.role).toBe('user')
    expect(retried.messages.at(-1)?.content).toBe('qual o preço?')
    expect(requestedDelays).toContain(1000)
  })

  it('prefill persistente → esgota retries e devolve erro (não fica em loop)', async () => {
    mocks.generateText.mockRejectedValue(apiError(400, PREFILL_BODY, 'Bad Request'))

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(mocks.generateText).toHaveBeenCalledTimes(3)
    expect(result.success).toBe(false)
  })

  it('não inicia retry que não cabe no deadline da função', async () => {
    mocks.generateText.mockRejectedValue(apiError(503, 'overloaded', 'Service Unavailable'))

    // Só 5s de orçamento: 1s de backoff + 10s mínimos de tentativa não cabem
    const result = await processChatAgent({ agent, conversation, messages: pendingHistory, deadlineAt: Date.now() + 5_000 })

    expect(mocks.generateText).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(requestedDelays).not.toContain(1000)
  })

  it('handoff explícito pedido pela IA (shouldHandoff: true) continua igual', async () => {
    mocks.generateText.mockImplementation(async (args: GenerateArgs) => {
      await args.tools.respond.execute({
        message: 'Vou te transferir para um atendente.',
        sentiment: 'frustrated',
        confidence: 0.8,
        shouldHandoff: true,
        handoffReason: 'Cliente pediu humano',
        handoffSummary: 'Quer falar com atendente',
      })
      return { text: '', steps: [], finishReason: 'tool-calls', response: {}, warnings: [], usage: {} }
    })

    const result = await processChatAgent({ agent, conversation, messages: pendingHistory })

    expect(result.success).toBe(true)
    expect(result.response).toMatchObject({
      shouldHandoff: true,
      handoffReason: 'Cliente pediu humano',
      handoffSummary: 'Quer falar com atendente',
    })
    expect(mocks.generateText).toHaveBeenCalledTimes(1)
  })
})
