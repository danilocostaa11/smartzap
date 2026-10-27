/**
 * Normalização do histórico da conversa antes de enviar ao LLM.
 *
 * Regra central: o histórico enviado ao modelo DEVE terminar numa mensagem do
 * usuário. Claude (direto ou via OpenCode Go) rejeita requisições cuja última
 * mensagem é do assistente ("assistant message prefill"). Isso acontece quando um
 * job duplicado/atrasado roda depois que a resposta já saiu: não há mensagem do
 * usuário pendente, então não há o que responder — a chamada deve ser pulada.
 *
 * Funções puras (sem I/O), compartilhadas pela rota /api/ai/respond e pelo chat-agent.
 */

import type { InboxMessage } from '@/types'

export type AIChatRole = 'user' | 'assistant'

export interface AIChatMessage {
  role: AIChatRole
  content: string
}

/** Mensagens que entram no contexto do modelo (notas internas ficam de fora). */
export function isConversationalMessage(message: InboxMessage): boolean {
  return message.message_type !== 'internal_note'
}

/** Converte mensagens do inbox para o formato do AI SDK (inbound = user, outbound = assistant). */
export function toAIChatMessages(messages: InboxMessage[]): AIChatMessage[] {
  return messages.filter(isConversationalMessage).map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }))
}

/**
 * Remove mensagens do assistente no FIM do histórico, para que a última seja do usuário.
 * Retorna [] quando não há nenhuma mensagem do usuário (nada pendente para responder).
 */
export function trimTrailingAssistantMessages<T extends { role: AIChatRole }>(messages: T[]): T[] {
  let end = messages.length
  while (end > 0 && messages[end - 1].role === 'assistant') end--
  return end === messages.length ? messages : messages.slice(0, end)
}

/** true se o histórico (já no formato do modelo) termina numa mensagem do usuário. */
export function endsWithUserMessage(messages: Array<{ role: AIChatRole }>): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === 'user'
}

/**
 * Existe um turno do usuário pendente? (última mensagem conversacional é inbound)
 * Se não, o bot já respondeu tudo e a IA não deve ser chamada.
 */
export function hasPendingUserTurn(messages: InboxMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isConversationalMessage(messages[i])) continue
    return messages[i].direction === 'inbound'
  }
  return false
}
