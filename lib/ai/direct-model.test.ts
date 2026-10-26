import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createOpenCodeGoModel, googleFactory, openaiFactory } = vi.hoisted(() => ({
  createOpenCodeGoModel: vi.fn(async (id: string) => ({ modelId: id, provider: 'opencode-go' })),
  googleFactory: vi.fn((id: string) => ({ modelId: id, provider: 'google' })),
  openaiFactory: vi.fn((id: string) => ({ modelId: id, provider: 'openai' })),
}))

vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>()
  return { ...actual, createOpenCodeGoModel }
})
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => googleFactory) }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => openaiFactory) }))

import { createDirectModel } from './direct-model'
import type { AiDirectConfig } from './ai-center-defaults'

describe('createDirectModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('OpenCode Go: usa o id do agente e devolve o id resolvido', async () => {
    const config: AiDirectConfig = { provider: 'opencode_go', model: 'claude-haiku-5-5', opencodeGoApiKey: 'k' }
    const result = await createDirectModel(config, 'claude-haiku-5-5', { sessionId: 's1' })

    expect(result.provider).toBe('opencode_go')
    expect(result.modelId).toBe('claude-haiku-5-5')
    expect(createOpenCodeGoModel).toHaveBeenCalledWith('claude-haiku-5-5', 'k', { sessionId: 's1' })
  })

  it('OpenCode Go: id de outro provider salvo no agente cai no padrão do OpenCode Go', async () => {
    const config: AiDirectConfig = { provider: 'opencode_go', model: 'claude-haiku-5-5', opencodeGoApiKey: 'k' }
    const result = await createDirectModel(config, 'gemini-2.5-flash')

    expect(result.modelId).toBe('claude-haiku-5-5')
    expect(createOpenCodeGoModel).toHaveBeenCalledWith('claude-haiku-5-5', 'k', { sessionId: undefined })
    expect(googleFactory).not.toHaveBeenCalled()
  })

  it('OpenCode Go sem chave: erro legível e nunca cai em outro provider', async () => {
    const config: AiDirectConfig = { provider: 'opencode_go', model: 'claude-haiku-5-5', openaiApiKey: 'o', googleApiKey: 'g' }
    await expect(createDirectModel(config, 'claude-haiku-5-5')).rejects.toThrow('Chave OpenCode Go não configurada')
    expect(openaiFactory).not.toHaveBeenCalled()
    expect(googleFactory).not.toHaveBeenCalled()
  })

  it('Google: usa o id do agente, ou o configurado, ou o padrão', async () => {
    const config: AiDirectConfig = { provider: 'google', model: 'gemini-2.5-pro', googleApiKey: 'g' }
    expect((await createDirectModel(config, 'gemini-2.5-flash')).modelId).toBe('gemini-2.5-flash')
    expect((await createDirectModel(config)).modelId).toBe('gemini-2.5-pro')
    expect((await createDirectModel({ ...config, model: '' })).modelId).toBe('gemini-2.5-flash')
    expect(googleFactory).toHaveBeenCalledTimes(3)
  })

  it('OpenAI: exige chave própria', async () => {
    await expect(
      createDirectModel({ provider: 'openai', model: 'gpt-4o', googleApiKey: 'g' }, 'gpt-4o')
    ).rejects.toThrow('Chave OpenAI não configurada')

    const result = await createDirectModel({ provider: 'openai', model: 'gpt-4o', openaiApiKey: 'o' }, 'gpt-4o-mini')
    expect(result.provider).toBe('openai')
    expect(result.modelId).toBe('gpt-4o-mini')
    expect(openaiFactory).toHaveBeenCalledWith('gpt-4o-mini')
  })
})
