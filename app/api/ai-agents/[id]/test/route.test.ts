// @vitest-environment node
/**
 * Chat de teste do agente: a busca RAG precisa receber a chave do provider de EMBEDDING,
 * resolvida do mesmo jeito que o chat-agent de produção (resolveEmbeddingApiKeyForAgent).
 * Sem a chave no embeddingConfig, findRelevantContent cai no gateway e falha com
 * "Nenhuma chave de embedding disponível para google".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    generateText: vi.fn(),
    findRelevantContent: vi.fn(),
    hasIndexedContent: vi.fn(),
    resolveEmbeddingApiKeyForAgent: vi.fn(),
    supabase: { current: null as unknown },
  },
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  tool: (definition: unknown) => definition,
  stepCountIs: () => () => false,
}))
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mocks.supabase.current }))
vi.mock('@/lib/ai/devtools', () => ({ withDevTools: async (model: unknown) => model }))
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
vi.mock('@/lib/ai/rag-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/rag-store')>('@/lib/ai/rag-store')
  return {
    ...actual,
    findRelevantContent: mocks.findRelevantContent,
    hasIndexedContent: mocks.hasIndexedContent,
    resolveEmbeddingApiKeyForAgent: mocks.resolveEmbeddingApiKeyForAgent,
  }
})

import { createFakeSupabase } from '@/tests/helpers/fake-supabase-query'
import { POST } from './route'

const AGENT_ID = 'agent-1'

const agent = {
  id: AGENT_ID,
  name: 'Agente Teste',
  system_prompt: 'Você é um assistente.',
  model: 'claude-haiku-5-5',
  temperature: 0.7,
  max_tokens: 1024,
  is_active: true,
  handoff_enabled: false,
  embedding_provider: 'google',
  embedding_model: 'gemini-embedding-001',
  embedding_dimensions: 768,
  rag_max_results: 3,
  rag_similarity_threshold: 0.6,
}

type GenerateArgs = {
  tools: Record<string, { execute?: (input: Record<string, unknown>) => Promise<unknown> }>
}

/** Simula o LLM buscando na base e depois chamando `respond`. */
async function searchThenRespond(args: GenerateArgs) {
  await args.tools.searchKnowledgeBase.execute!({ query: 'qual o preço?' })
  return {
    staticToolCalls: [
      { toolName: 'respond', input: { message: 'Custa R$ 10.', sentiment: 'neutral', confidence: 0.9 } },
    ],
  }
}

function request(message = 'qual o preço?') {
  return new Request(`http://localhost:3000/api/ai-agents/${AGENT_ID}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
}

async function callRoute() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await POST(request() as any, { params: Promise.resolve({ id: AGENT_ID }) })
  return { status: response.status, body: await response.json() }
}

describe('POST /api/ai-agents/[id]/test — chave de embedding na busca RAG', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mocks.supabase.current = createFakeSupabase({
      tables: {
        ai_agents: () => ({ data: agent, error: null }),
        ai_knowledge_files: () => ({ data: null, error: null }),
      },
    })
    mocks.generateText.mockReset().mockImplementation(searchThenRespond)
    mocks.hasIndexedContent.mockReset().mockResolvedValue(true)
    mocks.findRelevantContent.mockReset().mockResolvedValue([{ content: 'O produto custa R$ 10.', similarity: 0.91 }])
    mocks.resolveEmbeddingApiKeyForAgent
      .mockReset()
      .mockResolvedValue({ apiKey: 'google-key-from-settings', providerLabel: 'Google Gemini', provider: 'google' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolve a chave com resolveEmbeddingApiKeyForAgent e a passa no embeddingConfig (como em produção)', async () => {
    const result = await callRoute()

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ response: 'Custa R$ 10.', search_performed: true, rag_chunks_used: 1 })

    expect(mocks.resolveEmbeddingApiKeyForAgent).toHaveBeenCalledTimes(1)
    expect(mocks.resolveEmbeddingApiKeyForAgent).toHaveBeenCalledWith(expect.objectContaining({ id: AGENT_ID }))

    expect(mocks.findRelevantContent).toHaveBeenCalledTimes(1)
    expect(mocks.findRelevantContent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        query: 'qual o preço?',
        topK: 3,
        threshold: 0.6,
        embeddingConfig: {
          provider: 'google',
          model: 'gemini-embedding-001',
          dimensions: 768,
          apiKey: 'google-key-from-settings',
        },
      })
    )
  })

  it('sem chave de embedding: não oferece a tool de busca (não tenta RAG sem chave)', async () => {
    mocks.resolveEmbeddingApiKeyForAgent.mockResolvedValue({ apiKey: null, providerLabel: 'Google Gemini', provider: 'google' })
    mocks.generateText.mockImplementation(async (args: GenerateArgs) => {
      expect(args.tools.searchKnowledgeBase).toBeUndefined()
      return {
        staticToolCalls: [{ toolName: 'respond', input: { message: 'Olá!', sentiment: 'neutral', confidence: 0.5 } }],
      }
    })

    const result = await callRoute()

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ response: 'Olá!', search_performed: false, rag_chunks_used: 0 })
    expect(mocks.findRelevantContent).not.toHaveBeenCalled()
  })
})
