/**
 * Opt-out por palavra-chave (inbound WhatsApp).
 *
 * Quando o contato responde "Sair", "parar", "descadastrar" etc., precisamos:
 *   1. registrar a supressão do telefone (bloqueia envios automáticos);
 *   2. marcar o contato como OPT_OUT em `contacts.status` — é esse campo que o
 *      painel exibe e que os contadores (`get_contact_stats`, tela de Contatos)
 *      usam. Antes só a supressão era gravada, então o contato continuava
 *      "Opt-in" no painel e o contador de opt-out ficava em 0.
 *
 * Este módulo é independente do webhook para poder ser testado em isolamento e
 * reutilizado (ex.: backfill, ferramentas MCP).
 */

import { supabase } from '@/lib/supabase'
import { normalizePhoneNumber } from '@/lib/phone-formatter'
import { upsertPhoneSuppression } from '@/lib/phone-suppressions'
import { ContactStatus } from '@/types'

/**
 * Palavras isoladas: casam como palavra inteira (evita "comparecer" → "pare",
 * "sairá" → "sair"). Frases casam por inclusão.
 */
export const OPT_OUT_KEYWORDS = [
  'parar',
  'pare',
  'stop',
  'cancelar',
  'cancele',
  'sair',
  'remover',
  'remove',
  'descadastrar',
  'desinscrever',
  'unsubscribe',
  'optout',
  'opt-out',
  'opt out',
] as const

export const OPT_OUT_PHRASES = ['nao quero', 'nao receber', 'nao me mande', 'nao mande mais'] as const

const normalizeText = (raw: unknown): string =>
  String(raw ?? '')
    .trim()
    .toLowerCase()
    // normaliza acentos (não → nao) para facilitar matching
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

const KEYWORD_PATTERN = new RegExp(
  `(^|[^a-z0-9])(${OPT_OUT_KEYWORDS.map(escapeRegex).join('|')})(?=$|[^a-z0-9])`,
  'i'
)

/**
 * Detecta pedido de opt-out em texto livre (PT-BR + EN).
 *
 * @example
 * isOptOutKeyword('Sair')                 // true
 * isOptOutKeyword('por favor parar')      // true
 * isOptOutKeyword('não quero mais')       // true
 * isOptOutKeyword('vou comparecer amanhã')// false
 */
export function isOptOutKeyword(textRaw: unknown): boolean {
  const t = normalizeText(textRaw)
  if (!t) return false
  if (KEYWORD_PATTERN.test(t)) return true
  return OPT_OUT_PHRASES.some((phrase) => t.includes(phrase))
}

/**
 * Variações de armazenamento do mesmo telefone (com e sem "+").
 * `contacts.phone` é E.164 com "+", mas bases importadas podem não ter o prefixo.
 */
export function phoneStorageVariants(phoneRaw: string): string[] {
  const normalized = normalizePhoneNumber(String(phoneRaw || '').trim()) || String(phoneRaw || '').trim()
  if (!normalized) return []
  const digits = normalized.replace(/\D/g, '')
  return Array.from(new Set([normalized, digits ? `+${digits}` : '', digits].filter(Boolean)))
}

export interface ApplyOptOutInput {
  phoneRaw: string
  source: string
  reason: string
  metadata?: Record<string, unknown>
}

export interface ApplyOptOutResult {
  phone: string
  suppressed: boolean
  contactsUpdated: number
}

/**
 * Aplica o opt-out: supressão (best-effort) + `contacts.status = OPT_OUT`.
 *
 * Nunca lança: cada etapa é independente e falhas são logadas, para não
 * derrubar o webhook nem o fluxo da IA. O retorno informa o que foi gravado.
 */
export async function applyInboundOptOut(input: ApplyOptOutInput): Promise<ApplyOptOutResult> {
  const phone = normalizePhoneNumber(String(input.phoneRaw || '').trim()) || String(input.phoneRaw || '').trim()
  const result: ApplyOptOutResult = { phone, suppressed: false, contactsUpdated: 0 }
  if (!phone) return result

  try {
    await upsertPhoneSuppression({
      phone,
      reason: input.reason,
      source: input.source,
      metadata: input.metadata || {},
      isActive: true,
      expiresAt: null,
    })
    result.suppressed = true
  } catch (e) {
    console.warn('[OptOut] Falha ao upsert phone_suppressions (best-effort):', e)
  }

  try {
    const variants = phoneStorageVariants(phone)
    // Idempotente: reaplicar OPT_OUT em quem já está OPT_OUT não muda nada.
    const { data, error } = await supabase
      .from('contacts')
      .update({ status: ContactStatus.OPT_OUT, updated_at: new Date().toISOString() })
      .in('phone', variants)
      .select('id')

    if (error) throw error
    result.contactsUpdated = Array.isArray(data) ? data.length : 0
  } catch (e) {
    console.warn('[OptOut] Falha ao marcar contato como OPT_OUT (best-effort):', e)
  }

  return result
}
