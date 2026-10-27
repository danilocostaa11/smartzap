// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InboxMessage } from '@/types'

const { fakeRedis } = await vi.hoisted(async () => {
  const { FakeRedis } = await import('@/tests/helpers/fake-redis')
  return { fakeRedis: new FakeRedis() }
})

vi.mock('@/lib/redis', () => ({
  redis: fakeRedis,
  isRedisConfigured: () => true,
}))

import {
  acquireConversationLock,
  evaluateDebounce,
  getLastAnsweredMessageId,
  markLatestInboundMessage,
  normalizeDebounceState,
  readDebounceState,
  releaseConversationLock,
  selectPendingInboundMessages,
  setLastAnsweredMessageId,
} from './ai-debounce'

function msg(partial: Partial<InboxMessage> & { id: string; direction: InboxMessage['direction'] }): InboxMessage {
  return {
    conversation_id: 'conv-1',
    content: partial.content ?? partial.id,
    message_type: 'text',
    media_url: null,
    whatsapp_message_id: `wamid.${partial.id}`,
    delivery_status: 'delivered',
    ai_response_id: null,
    ai_sentiment: null,
    ai_sources: null,
    payload: null,
    created_at: new Date().toISOString(),
    ...partial,
  } as InboxMessage
}

describe('ai-debounce', () => {
  beforeEach(() => {
    fakeRedis.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('evaluateDebounce (puro)', () => {
    it('processa quando não há estado (fail-open)', () => {
      expect(evaluateDebounce({ state: null, messageId: 'wamid.1', debounceMs: 5000 })).toEqual({ action: 'process' })
    })

    it('pula como superseded quando existe mensagem mais recente', () => {
      const state = { ts: Date.now() - 10_000, messageId: 'wamid.6' }
      expect(evaluateDebounce({ state, messageId: 'wamid.3', debounceMs: 5000 })).toEqual({
        action: 'skip',
        reason: 'superseded',
      })
    })

    it('pula como user-still-typing quando ainda está na janela de debounce', () => {
      const now = 1_000_000
      const state = { ts: now - 1000, messageId: 'wamid.6' }
      expect(evaluateDebounce({ state, messageId: 'wamid.6', debounceMs: 5000, now })).toEqual({
        action: 'skip',
        reason: 'user-still-typing',
      })
    })

    it('processa quando é a mensagem mais recente e o usuário parou de digitar', () => {
      const now = 1_000_000
      const state = { ts: now - 5000, messageId: 'wamid.6' }
      expect(evaluateDebounce({ state, messageId: 'wamid.6', debounceMs: 5000, now })).toEqual({ action: 'process' })
    })

    it('com debounce desabilitado (0) só aplica a regra de mensagem mais recente', () => {
      const now = 1_000_000
      const state = { ts: now, messageId: 'wamid.2' }
      expect(evaluateDebounce({ state, messageId: 'wamid.2', debounceMs: 0, now })).toEqual({ action: 'process' })
      expect(evaluateDebounce({ state, messageId: 'wamid.1', debounceMs: 0, now })).toEqual({
        action: 'skip',
        reason: 'superseded',
      })
    })

    it('aceita estado legado (apenas timestamp) sem messageId', () => {
      const now = 1_000_000
      expect(normalizeDebounceState(now - 100)).toEqual({ ts: now - 100, messageId: null })
      expect(normalizeDebounceState(String(now - 100))).toEqual({ ts: now - 100, messageId: null })
      expect(normalizeDebounceState(JSON.stringify({ ts: 5, messageId: 'x' }))).toEqual({ ts: 5, messageId: 'x' })
      expect(normalizeDebounceState({ foo: 'bar' })).toBeNull()

      const state = normalizeDebounceState(now - 100)
      expect(evaluateDebounce({ state, messageId: 'wamid.9', debounceMs: 5000, now })).toEqual({
        action: 'skip',
        reason: 'user-still-typing',
      })
    })
  })

  describe('marcador da última mensagem', () => {
    it('grava { ts, messageId } e lê de volta', async () => {
      const ok = await markLatestInboundMessage('conv-1', 'wamid.3', 60, 123_456)
      expect(ok).toBe(true)
      expect(await readDebounceState('conv-1')).toEqual({ ts: 123_456, messageId: 'wamid.3' })
    })

    it('a última escrita vence (reset do timer)', async () => {
      await markLatestInboundMessage('conv-1', 'wamid.1', 60, 1)
      await markLatestInboundMessage('conv-1', 'wamid.2', 60, 2)
      expect(await readDebounceState('conv-1')).toEqual({ ts: 2, messageId: 'wamid.2' })
    })

    it('fail-open quando o Redis falha', async () => {
      fakeRedis.failing = true
      expect(await markLatestInboundMessage('conv-1', 'wamid.1', 60)).toBe(false)
      expect(await readDebounceState('conv-1')).toBeNull()
    })
  })

  describe('lock por conversa', () => {
    it('só um dos concorrentes adquire o lock (SET NX)', async () => {
      const results = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((token) => acquireConversationLock('conv-1', token, 60))
      )
      expect(results.filter((r) => r === 'acquired')).toHaveLength(1)
      expect(results.filter((r) => r === 'busy')).toHaveLength(5)
    })

    it('release só remove o lock do próprio dono', async () => {
      await acquireConversationLock('conv-1', 'owner', 60)
      await releaseConversationLock('conv-1', 'intruder')
      expect(fakeRedis.peek('ai:lock:conv-1')).toBe('owner')

      await releaseConversationLock('conv-1', 'owner')
      expect(fakeRedis.has('ai:lock:conv-1')).toBe(false)

      expect(await acquireConversationLock('conv-1', 'next', 60)).toBe('acquired')
    })

    it('lock expira por TTL', async () => {
      let now = 1_000_000
      fakeRedis.now = () => now
      await acquireConversationLock('conv-1', 'owner', 10)
      expect(await acquireConversationLock('conv-1', 'other', 10)).toBe('busy')
      now += 11_000
      expect(await acquireConversationLock('conv-1', 'other', 10)).toBe('acquired')
    })

    it('retorna unavailable quando o Redis falha (fail-open no chamador)', async () => {
      fakeRedis.failing = true
      expect(await acquireConversationLock('conv-1', 'x', 60)).toBe('unavailable')
      await expect(releaseConversationLock('conv-1', 'x')).resolves.toBeUndefined()
    })
  })

  describe('última mensagem respondida', () => {
    it('grava e lê o id', async () => {
      expect(await getLastAnsweredMessageId('conv-1')).toBeNull()
      await setLastAnsweredMessageId('conv-1', 'm6')
      expect(await getLastAnsweredMessageId('conv-1')).toBe('m6')
    })
  })

  describe('selectPendingInboundMessages (puro)', () => {
    it('sem histórico de resposta: todas as inbound após a última outbound', () => {
      const messages = [
        msg({ id: 'm1', direction: 'inbound' }),
        msg({ id: 'o1', direction: 'outbound' }),
        msg({ id: 'm2', direction: 'inbound' }),
        msg({ id: 'm3', direction: 'inbound' }),
        msg({ id: 'n1', direction: 'outbound', message_type: 'internal_note' }),
        msg({ id: 'm4', direction: 'inbound' }),
      ]
      expect(selectPendingInboundMessages(messages).map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
    })

    it('burst inicial sem nenhuma outbound: todas as mensagens', () => {
      const messages = Array.from({ length: 6 }, (_, i) => msg({ id: `m${i + 1}`, direction: 'inbound', content: 'oi' }))
      expect(selectPendingInboundMessages(messages, null)).toHaveLength(6)
    })

    it('com lastAnsweredId: só o que veio depois dela, mesmo que a outbound ainda não tenha sido salva', () => {
      const messages = [
        msg({ id: 'm5', direction: 'inbound' }),
        msg({ id: 'm6', direction: 'inbound' }),
        msg({ id: 'm7', direction: 'inbound' }), // chegou durante a geração da resposta
      ]
      expect(selectPendingInboundMessages(messages, 'm6').map((m) => m.id)).toEqual(['m7'])
    })

    it('com lastAnsweredId e resposta já salva: nada pendente', () => {
      const messages = [
        msg({ id: 'm6', direction: 'inbound' }),
        msg({ id: 'o1', direction: 'outbound' }),
      ]
      expect(selectPendingInboundMessages(messages, 'm6')).toEqual([])
    })

    it('mensagem que chegou durante a geração continua pendente mesmo depois da outbound ser salva', () => {
      const messages = [
        msg({ id: 'm6', direction: 'inbound' }),
        msg({ id: 'm7', direction: 'inbound' }),
        msg({ id: 'o1', direction: 'outbound' }), // resposta às m1..m6
      ]
      expect(selectPendingInboundMessages(messages, 'm6').map((m) => m.id)).toEqual(['m7'])
    })

    it('lastAnsweredId fora da janela: cai na heurística da última outbound', () => {
      const messages = [
        msg({ id: 'o1', direction: 'outbound' }),
        msg({ id: 'm8', direction: 'inbound' }),
      ]
      expect(selectPendingInboundMessages(messages, 'm-antiga').map((m) => m.id)).toEqual(['m8'])
    })
  })
})

describe('ai-debounce sem Redis configurado', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('@/lib/redis')
    vi.resetModules()
  })

  it('todas as operações são no-op e sinalizam indisponibilidade (fail-open)', async () => {
    vi.doMock('@/lib/redis', () => ({ redis: null, isRedisConfigured: () => false }))
    const mod = await import('./ai-debounce')

    expect(await mod.markLatestInboundMessage('conv-1', 'wamid.1', 60)).toBe(false)
    expect(await mod.readDebounceState('conv-1')).toBeNull()
    expect(await mod.acquireConversationLock('conv-1', 'x')).toBe('unavailable')
    expect(await mod.getLastAnsweredMessageId('conv-1')).toBeNull()
    await expect(mod.setLastAnsweredMessageId('conv-1', 'm1')).resolves.toBeUndefined()
    await expect(mod.releaseConversationLock('conv-1', 'x')).resolves.toBeUndefined()
    expect(mod.evaluateDebounce({ state: null, messageId: 'wamid.1', debounceMs: 5000 })).toEqual({ action: 'process' })
  })
})
