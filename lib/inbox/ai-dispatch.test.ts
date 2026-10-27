// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildDeduplicationId, resolveAIRespondUrl } from './ai-dispatch'

describe('ai-dispatch', () => {
  describe('resolveAIRespondUrl', () => {
    it('prioriza NEXT_PUBLIC_APP_URL', () => {
      expect(
        resolveAIRespondUrl({
          NEXT_PUBLIC_APP_URL: 'https://app.example.com/',
          VERCEL_ENV: 'preview',
          VERCEL_URL: 'preview-abc.vercel.app',
          VERCEL_PROJECT_PRODUCTION_URL: 'prod.example.com',
        })
      ).toBe('https://app.example.com/api/ai/respond')
    })

    it('em preview usa a URL do próprio deploy (e não a de produção)', () => {
      expect(
        resolveAIRespondUrl({
          VERCEL_ENV: 'preview',
          VERCEL_URL: 'smartzap-git-branch-abc.vercel.app',
          VERCEL_PROJECT_PRODUCTION_URL: 'prod.example.com',
        })
      ).toBe('https://smartzap-git-branch-abc.vercel.app/api/ai/respond')
    })

    it('em produção continua usando VERCEL_PROJECT_PRODUCTION_URL', () => {
      expect(
        resolveAIRespondUrl({
          VERCEL_ENV: 'production',
          VERCEL_URL: 'smartzap-abc123.vercel.app',
          VERCEL_PROJECT_PRODUCTION_URL: 'prod.example.com',
        })
      ).toBe('https://prod.example.com/api/ai/respond')
    })

    it('fallback para localhost', () => {
      expect(resolveAIRespondUrl({})).toBe('http://localhost:3000/api/ai/respond')
    })
  })

  describe('buildDeduplicationId', () => {
    it('sanitiza o messageId e diferencia reagendamentos', () => {
      expect(buildDeduplicationId('wamid.HBgL:abc==')).toBe('ai_respond_wamid_HBgL_abc__')
      expect(buildDeduplicationId('wamid.1', 0)).toBe('ai_respond_wamid_1')
      expect(buildDeduplicationId('wamid.1', 2)).toBe('ai_respond_wamid_1_a2')
    })
  })
})
