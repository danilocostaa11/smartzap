import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TEMPERATURE,
  REASONING_MIN_OUTPUT_TOKENS,
  normalizeReasoningLevel,
  resolveMaxOutputTokens,
  resolveProviderOptions,
  resolveTemperature,
  supportsReasoningLevel,
  supportsTemperature,
} from './model-capabilities'

describe('supportsTemperature', () => {
  it('rejeita temperature em modelos Claude 5.x+ (todas as famílias e sufixos)', () => {
    expect(supportsTemperature('claude-haiku-5-5')).toBe(false)
    expect(supportsTemperature('claude-opus-5-5')).toBe(false)
    expect(supportsTemperature('claude-sonnet-5-5')).toBe(false)
    expect(supportsTemperature('claude-sonnet-5')).toBe(false)
    expect(supportsTemperature('claude-opus-5.5')).toBe(false)
    expect(supportsTemperature('claude-haiku-5-5-20261001')).toBe(false)
    expect(supportsTemperature('claude-opus-6')).toBe(false)
    expect(supportsTemperature('Claude-Haiku-5-5')).toBe(false)
  })

  it('ignora prefixo de provider', () => {
    expect(supportsTemperature('anthropic/claude-haiku-5-5')).toBe(false)
    expect(supportsTemperature('opencode_go/claude-sonnet-5-5')).toBe(false)
    expect(supportsTemperature('google/gemini-2.5-flash')).toBe(true)
  })

  it('mantém temperature para modelos Claude anteriores à geração 5', () => {
    expect(supportsTemperature('claude-sonnet-4-5')).toBe(true)
    expect(supportsTemperature('claude-opus-4-1')).toBe(true)
    expect(supportsTemperature('claude-3-5-haiku')).toBe(true)
    expect(supportsTemperature('claude-3-5-sonnet-20241022')).toBe(true)
  })

  it('mantém temperature para os demais providers/modelos', () => {
    expect(supportsTemperature('gemini-2.5-flash')).toBe(true)
    expect(supportsTemperature('gemini-flash-latest')).toBe(true)
    expect(supportsTemperature('gpt-4o-mini')).toBe(true)
    expect(supportsTemperature('deepseek-v4.1-flash')).toBe(true)
    expect(supportsTemperature('glm-5.3')).toBe(true)
    expect(supportsTemperature('kimi-k3')).toBe(true)
    expect(supportsTemperature('minimax-m3')).toBe(true)
    expect(supportsTemperature('qwen3.7-plus')).toBe(true)
  })

  it('assume suporte quando o id está vazio/ausente', () => {
    expect(supportsTemperature('')).toBe(true)
    expect(supportsTemperature(null)).toBe(true)
    expect(supportsTemperature(undefined)).toBe(true)
  })
})

describe('resolveTemperature', () => {
  it('omite (undefined) para modelos que rejeitam temperature, mesmo com valor configurado', () => {
    expect(resolveTemperature('claude-haiku-5-5', 0.9)).toBeUndefined()
    expect(resolveTemperature('claude-opus-5-5', 0)).toBeUndefined()
    expect(resolveTemperature('claude-sonnet-5-5')).toBeUndefined()
  })

  it('devolve o valor configurado para modelos que aceitam temperature', () => {
    expect(resolveTemperature('gemini-2.5-flash', 0.3)).toBe(0.3)
    expect(resolveTemperature('gpt-4o', 0)).toBe(0)
    expect(resolveTemperature('deepseek-v4.1-flash', 1.5)).toBe(1.5)
  })

  it('usa o fallback quando não há valor configurado', () => {
    expect(resolveTemperature('gemini-2.5-flash')).toBe(DEFAULT_TEMPERATURE)
    expect(resolveTemperature('gemini-2.5-flash', null)).toBe(DEFAULT_TEMPERATURE)
    expect(resolveTemperature('gemini-2.5-flash', undefined, 0.2)).toBe(0.2)
  })
})

describe('nível de raciocínio (Gemini 3.x)', () => {
  it('suporta só a família Gemini 3.x (com ou sem prefixo de provider)', () => {
    expect(supportsReasoningLevel('gemini-3.8-flash')).toBe(true)
    expect(supportsReasoningLevel('google/gemini-3.8-flash')).toBe(true)
    expect(supportsReasoningLevel('gemini-3-flash-preview')).toBe(true)
    expect(supportsReasoningLevel('gemini-3-pro-preview')).toBe(true)
    expect(supportsReasoningLevel('gemini-2.5-flash')).toBe(false)
    expect(supportsReasoningLevel('gemini-flash-latest')).toBe(false)
    expect(supportsReasoningLevel('gemini-30-flash')).toBe(false)
    expect(supportsReasoningLevel('claude-haiku-5-5')).toBe(false)
    expect(supportsReasoningLevel(null)).toBe(false)
  })

  it('normaliza valores salvos; inválido vira null', () => {
    expect(normalizeReasoningLevel('high')).toBe('high')
    expect(normalizeReasoningLevel(' HIGH ')).toBe('high')
    expect(normalizeReasoningLevel('max')).toBeNull()
    expect(normalizeReasoningLevel(null)).toBeNull()
    expect(normalizeReasoningLevel(3)).toBeNull()
  })

  it('providerOptions com thinkingLevel só para Gemini 3.x com nível definido', () => {
    expect(resolveProviderOptions('gemini-3.8-flash', 'high')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    })
    expect(resolveProviderOptions('gemini-3.8-flash', null)).toBeUndefined()
    expect(resolveProviderOptions('gemini-2.5-flash', 'high')).toBeUndefined()
    expect(resolveProviderOptions('gpt-4o', 'high')).toBeUndefined()
  })

  it('piso de maxOutputTokens só quando o nível é aplicado', () => {
    expect(resolveMaxOutputTokens('gemini-3.8-flash', 'high', 1024)).toBe(REASONING_MIN_OUTPUT_TOKENS)
    expect(resolveMaxOutputTokens('gemini-3.8-flash', 'high', 16000)).toBe(16000)
    expect(resolveMaxOutputTokens('gemini-3.8-flash', null, 1024)).toBe(1024)
    expect(resolveMaxOutputTokens('gemini-2.5-flash', 'high', 1024)).toBe(1024)
  })
})
