import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveOpenCodeGoProtocol,
  normalizeOpenCodeGoModel,
  resolveOpenCodeGoModelId,
  resolveOpenCodeGoBaseUrl,
  OPENCODE_GO_BASE_URL_DEFAULT,
  OPENCODE_GO_DEFAULT_MODEL,
  isOpenCodeGoModel,
} from './providers'

describe('OpenCode Go provider', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
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
})
