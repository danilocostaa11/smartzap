// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { InboxMessage } from '@/types'
import {
  endsWithUserMessage,
  hasPendingUserTurn,
  toAIChatMessages,
  trimTrailingAssistantMessages,
} from './chat-history'

function msg(
  id: string,
  direction: 'inbound' | 'outbound',
  content = direction === 'inbound' ? 'oi' : 'Olá!',
  message_type: InboxMessage['message_type'] = 'text'
): InboxMessage {
  return { id, direction, content, message_type } as InboxMessage
}

describe('chat-history — histórico enviado ao modelo', () => {
  describe('toAIChatMessages', () => {
    it('mapeia inbound→user, outbound→assistant e ignora notas internas', () => {
      const result = toAIChatMessages([
        msg('1', 'inbound', 'oi'),
        msg('2', 'outbound', 'Olá!'),
        msg('3', 'outbound', 'Transferência', 'internal_note'),
        msg('4', 'inbound', 'preço?'),
      ])
      expect(result).toEqual([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'Olá!' },
        { role: 'user', content: 'preço?' },
      ])
    })
  })

  describe('trimTrailingAssistantMessages', () => {
    it('remove mensagens do assistente no fim até a última ser do usuário', () => {
      const history = [
        { role: 'user' as const, content: 'oi' },
        { role: 'assistant' as const, content: 'Olá!' },
        { role: 'assistant' as const, content: 'Como posso ajudar?' },
      ]
      expect(trimTrailingAssistantMessages(history)).toEqual([{ role: 'user', content: 'oi' }])
    })

    it('devolve o mesmo array quando já termina em user (sem cópia)', () => {
      const history = [
        { role: 'assistant' as const, content: 'Olá!' },
        { role: 'user' as const, content: 'oi' },
      ]
      expect(trimTrailingAssistantMessages(history)).toBe(history)
      expect(endsWithUserMessage(history)).toBe(true)
    })

    it('devolve [] quando não há nenhuma mensagem do usuário', () => {
      expect(trimTrailingAssistantMessages([{ role: 'assistant' as const, content: 'Olá!' }])).toEqual([])
      expect(trimTrailingAssistantMessages([])).toEqual([])
      expect(endsWithUserMessage([])).toBe(false)
    })
  })

  describe('hasPendingUserTurn', () => {
    it('true quando a última mensagem conversacional é do usuário', () => {
      expect(hasPendingUserTurn([msg('1', 'outbound'), msg('2', 'inbound')])).toBe(true)
    })

    it('false quando o bot já respondeu por último (job duplicado/atrasado)', () => {
      expect(hasPendingUserTurn([msg('1', 'inbound'), msg('2', 'outbound')])).toBe(false)
    })

    it('ignora notas internas depois da resposta/pergunta', () => {
      expect(
        hasPendingUserTurn([msg('1', 'inbound'), msg('2', 'outbound', 'nota', 'internal_note')])
      ).toBe(true)
      expect(
        hasPendingUserTurn([msg('1', 'inbound'), msg('2', 'outbound'), msg('3', 'outbound', 'nota', 'internal_note')])
      ).toBe(false)
    })

    it('false para histórico vazio', () => {
      expect(hasPendingUserTurn([])).toBe(false)
    })
  })
})
