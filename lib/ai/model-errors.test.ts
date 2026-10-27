// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import {
  classifyModelError,
  describeModelError,
  getModelErrorStatusCode,
  isAssistantPrefillError,
  isNetworkError,
  isTransientModelError,
} from './model-errors'

function apiError(statusCode: number, body: string, message = `HTTP ${statusCode}`) {
  return new APICallError({
    message,
    url: 'https://opencode.ai/zen/go/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
  })
}

const PREFILL_BODY =
  '{"type":"error","error":{"type":"invalid_request_error","message":"assistant message prefill is not supported for this model"}}'

describe('model-errors — classificação de erros do provider', () => {
  describe('prefill', () => {
    it('reconhece o 400 "assistant message prefill" do Claude (direto ou via OpenCode Go)', () => {
      const error = apiError(400, PREFILL_BODY, 'Bad Request')
      expect(isAssistantPrefillError(error)).toBe(true)
      expect(classifyModelError(error)).toBe('prefill')
    })

    it('reconhece variações de texto (Prefilling..., final assistant content ... trailing whitespace)', () => {
      expect(isAssistantPrefillError(new Error('Prefilling the assistant message is not supported'))).toBe(true)
      expect(
        isAssistantPrefillError(
          apiError(400, '{"error":{"message":"messages: final assistant content cannot end with trailing whitespace"}}')
        )
      ).toBe(true)
    })

    it('prefill tem prioridade mesmo sendo 400 (os demais 400 são fatais)', () => {
      expect(classifyModelError(apiError(400, PREFILL_BODY))).toBe('prefill')
      expect(classifyModelError(apiError(400, '{"error":{"message":"temperature is deprecated"}}'))).toBe('fatal')
    })

    it('enxerga o prefill mesmo quando o erro vem embrulhado em cause', () => {
      const wrapped = new Error('generateText failed', { cause: apiError(400, PREFILL_BODY) })
      expect(classifyModelError(wrapped)).toBe('prefill')
    })
  })

  describe('transient', () => {
    it.each([500, 502, 503, 504, 529])('status %i é transitório', (status) => {
      expect(isTransientModelError(apiError(status, 'upstream'))).toBe(true)
      expect(classifyModelError(apiError(status, 'upstream'))).toBe('transient')
    })

    it.each([408, 409, 425, 429])('status %i é transitório', (status) => {
      expect(classifyModelError(apiError(status, 'slow down'))).toBe('transient')
    })

    it('timeout do nosso AbortController é transitório', () => {
      const abort = new DOMException('This operation was aborted', 'AbortError')
      expect(classifyModelError(abort, { timedOut: true })).toBe('transient')
      // Abort que NÃO foi nosso timeout não é repetido
      expect(classifyModelError(abort)).toBe('fatal')
    })

    it('erros de rede (fetch failed / ECONNRESET / undici) são transitórios', () => {
      const fetchFailed = new TypeError('fetch failed')
      ;(fetchFailed as Error & { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      })
      expect(isNetworkError(fetchFailed)).toBe(true)
      expect(classifyModelError(fetchFailed)).toBe('transient')

      expect(classifyModelError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('transient')
      expect(classifyModelError(Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(
        'transient'
      )
      expect(classifyModelError(Object.assign(new Error('getaddrinfo ENOTFOUND opencode.ai'), { code: 'ENOTFOUND' }))).toBe(
        'transient'
      )
    })

    it('APICallError sem status mas com isRetryable=true é transitório (ex.: "Cannot connect to API")', () => {
      const error = new APICallError({
        message: 'Cannot connect to API: fetch failed',
        url: 'https://opencode.ai/zen/go/v1/messages',
        requestBodyValues: {},
        isRetryable: true,
      })
      expect(classifyModelError(error)).toBe('transient')
    })

    it('status também é lido de `status`, `response.status` e de string numérica', () => {
      expect(getModelErrorStatusCode({ status: 502 })).toBe(502)
      expect(getModelErrorStatusCode({ response: { status: 503 } })).toBe(503)
      expect(getModelErrorStatusCode({ statusCode: '429' })).toBe(429)
      expect(getModelErrorStatusCode(new Error('sem status'))).toBeUndefined()
    })
  })

  describe('fatal (não repetir)', () => {
    it.each([400, 401, 403, 404, 413, 422])('status %i (auth/config/validação) é fatal', (status) => {
      expect(isTransientModelError(apiError(status, 'nope'))).toBe(false)
      expect(classifyModelError(apiError(status, 'nope'))).toBe('fatal')
    })

    it('4xx com texto que parece rede continua fatal (status manda)', () => {
      expect(classifyModelError(apiError(401, '{"error":"invalid api key (connection refused by policy)"}'))).toBe('fatal')
    })

    it('erro genérico sem status nem padrão de rede é fatal', () => {
      expect(classifyModelError(new Error('No response generated - LLM did not call respond tool after retries'))).toBe('fatal')
      expect(classifyModelError('string error')).toBe('fatal')
      expect(classifyModelError(null)).toBe('fatal')
      expect(classifyModelError(undefined)).toBe('fatal')
    })
  })

  describe('describeModelError', () => {
    it('junta mensagem, responseBody e causas', () => {
      const error = new Error('outer', { cause: apiError(503, '{"error":"overloaded"}', 'Service Unavailable') })
      const text = describeModelError(error)
      expect(text).toContain('outer')
      expect(text).toContain('Service Unavailable')
      expect(text).toContain('overloaded')
    })

    it('não entra em loop com cause circular', () => {
      const a = new Error('a') as Error & { cause?: unknown }
      const b = new Error('b') as Error & { cause?: unknown }
      a.cause = b
      b.cause = a
      expect(describeModelError(a)).toBe('a | b')
      expect(classifyModelError(a)).toBe('fatal')
    })
  })
})
