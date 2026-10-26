import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const { createAnthropic, createOpenAI } = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => ({ languageModel: vi.fn((id: string) => ({ modelId: id, protocol: 'anthropic' })) })),
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((id: string) => ({ modelId: id, protocol: 'chat' })),
    responses: vi.fn((id: string) => ({ modelId: id, protocol: 'responses' })),
  })),
}))

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI }))

import {
  resolveOpenCodeGoProtocol,
  normalizeOpenCodeGoModel,
  resolveOpenCodeGoModelId,
  resolveOpenCodeGoBaseUrl,
  resolveOpenCodeGoSessionId,
  createOpenCodeGoModel,
  OPENCODE_GO_BASE_URL_DEFAULT,
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_SESSION_HEADER,
  isOpenCodeGoModel,
} from './providers'

type FactoryOpts = { apiKey: string; baseURL: string; headers: Record<string, string> }
const lastOpts = (fn: ReturnType<typeof vi.fn>): FactoryOpts => fn.mock.calls.at(-1)?.[0] as FactoryOpts

describe('OpenCode Go provider', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('default model is Claude Haiku 5.5 and uses Anthropic Messages protocol', () => {
    expect(OPENCODE_GO_DEFAULT_MODEL).toBe('claude-haiku-5-5')
    expect(resolveOpenCodeGoProtocol('claude-haiku-5-5')).toBe('anthropic')
  })

  it('routes chat-completions and responses models correctly', () => {
    expect(resolveOpenCodeGoProtocol('deepseek-v4.1-flash')).toBe('chat')
    expect(resolveOpenCodeGoProtocol('glm-5.3')).toBe('chat')
    expect(resolveOpenCodeGoProtocol('qwen3.7-plus')).toBe('anthropic')
    expect(resolveOpenCodeGoProtocol('gpt-6-luna')).toBe('responses')
  })

  it('maps legacy deepseek-v4-flash to deepseek-v4.1-flash', () => {
    expect(normalizeOpenCodeGoModel('deepseek-v4-flash')).toBe('deepseek-v4.1-flash')
    expect(resolveOpenCodeGoModelId('deepseek-v4-flash')).toBe('deepseek-v4.1-flash')
    expect(isOpenCodeGoModel('deepseek-v4-flash')).toBe(true)
  })

  it('never sends Google/OpenAI ids to OpenCode Go (falls back to default)', () => {
    expect(resolveOpenCodeGoModelId('gemini-2.5-flash')).toBe('claude-haiku-5-5')
    expect(resolveOpenCodeGoModelId('gpt-4o-mini')).toBe('claude-haiku-5-5')
    expect(resolveOpenCodeGoModelId('')).toBe('claude-haiku-5-5')
    expect(resolveOpenCodeGoModelId('claude-haiku-5-5')).toBe('claude-haiku-5-5')
  })

  it('base URL is configurable via OPENCODE_GO_BASE_URL', () => {
    delete process.env.OPENCODE_GO_BASE_URL
    expect(resolveOpenCodeGoBaseUrl()).toBe(OPENCODE_GO_BASE_URL_DEFAULT)
    expect(OPENCODE_GO_BASE_URL_DEFAULT).toBe('https://opencode.ai/zen/go/v1')
    process.env.OPENCODE_GO_BASE_URL = 'https://example.test/v1'
    expect(resolveOpenCodeGoBaseUrl()).toBe('https://example.test/v1')
  })

  it('OPENCODE_GO_DEFAULT_MODEL env overrides default', () => {
    process.env.OPENCODE_GO_DEFAULT_MODEL = 'glm-5.3'
    expect(resolveOpenCodeGoModelId(undefined)).toBe('glm-5.3')
  })

  describe('x-opencode-session header (obrigatório no gateway)', () => {
    it('resolveOpenCodeGoSessionId: mantém id estável informado, gera fallback quando ausente', () => {
      expect(resolveOpenCodeGoSessionId('smartzap-conv-1')).toBe('smartzap-conv-1')
      expect(resolveOpenCodeGoSessionId('  smartzap-conv-1  ')).toBe('smartzap-conv-1')

      const a = resolveOpenCodeGoSessionId(undefined)
      const b = resolveOpenCodeGoSessionId('')
      const c = resolveOpenCodeGoSessionId(null)
      for (const generated of [a, b, c]) {
        expect(generated).toMatch(/^smartzap-[0-9a-f-]{36}$/)
      }
      expect(new Set([a, b, c]).size).toBe(3)
    })

    it('anthropic protocol: envia o sessionId informado (comportamento do inbox/WhatsApp preservado)', async () => {
      await createOpenCodeGoModel('claude-haiku-5-5', 'key', { sessionId: 'smartzap-conv-42' })

      expect(createAnthropic).toHaveBeenCalledTimes(1)
      const opts = lastOpts(createAnthropic)
      expect(opts.apiKey).toBe('key')
      expect(opts.baseURL).toBe(OPENCODE_GO_BASE_URL_DEFAULT)
      expect(opts.headers[OPENCODE_GO_SESSION_HEADER]).toBe('smartzap-conv-42')
      expect(opts.headers['User-Agent']).toBe('smartzap/1.0')
      expect(createOpenAI).not.toHaveBeenCalled()
    })

    it('anthropic protocol: SEMPRE envia o header mesmo sem sessionId (chat de teste, judge, templates)', async () => {
      await createOpenCodeGoModel('claude-haiku-5-5', 'key')
      expect(lastOpts(createAnthropic).headers[OPENCODE_GO_SESSION_HEADER]).toMatch(/^smartzap-[0-9a-f-]{36}$/)

      await createOpenCodeGoModel('claude-haiku-5-5', 'key', { sessionId: '' })
      expect(lastOpts(createAnthropic).headers[OPENCODE_GO_SESSION_HEADER]).toMatch(/^smartzap-[0-9a-f-]{36}$/)
    })

    it('chat e responses protocols: também enviam o header', async () => {
      await createOpenCodeGoModel('deepseek-v4.1-flash', 'key')
      expect(lastOpts(createOpenAI).headers[OPENCODE_GO_SESSION_HEADER]).toMatch(/^smartzap-/)

      await createOpenCodeGoModel('gpt-6-luna', 'key', { sessionId: 'smartzap-x' })
      expect(lastOpts(createOpenAI).headers[OPENCODE_GO_SESSION_HEADER]).toBe('smartzap-x')
      expect(createAnthropic).not.toHaveBeenCalled()
    })
  })
})
