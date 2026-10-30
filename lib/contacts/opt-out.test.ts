// @vitest-environment node
/**
 * Opt-out por palavra-chave: além da supressão, o contato precisa virar OPT_OUT
 * em `contacts.status` (é o que o painel mostra e o que os contadores usam).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { supabase: { current: null as unknown } },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => (mocks.supabase.current as any).from(table),
  },
}))

import { applyInboundOptOut, isOptOutKeyword, phoneStorageVariants } from './opt-out'

type UpdateCall = { table: string; payload: Record<string, unknown>; column: string; values: unknown[] }
type UpsertCall = { table: string; payload: Record<string, unknown>; options: unknown }

/** Fake mínimo para `from().upsert()` e `from().update().in().select()`. */
function createOptOutFake(options: {
  contactPhones?: string[]
  upsertError?: { message: string } | null
  updateError?: { message: string } | null
} = {}) {
  const upserts: UpsertCall[] = []
  const updates: UpdateCall[] = []
  const contactPhones = options.contactPhones ?? []

  return {
    upserts,
    updates,
    from(table: string) {
      return {
        upsert: async (payload: Record<string, unknown>, opts: unknown) => {
          upserts.push({ table, payload, options: opts })
          return { data: null, error: options.upsertError ?? null }
        },
        update: (payload: Record<string, unknown>) => ({
          in: (column: string, values: unknown[]) => ({
            select: async () => {
              updates.push({ table, payload, column, values })
              if (options.updateError) return { data: null, error: options.updateError }
              const matched = contactPhones.filter((p) => values.includes(p)).map((p, i) => ({ id: `id-${i}-${p}` }))
              return { data: matched, error: null }
            },
          }),
        }),
      }
    },
  }
}

describe('isOptOutKeyword', () => {
  it.each([
    'Sair',
    'SAIR',
    'sair',
    ' sair ',
    'Quero sair.',
    'parar',
    'Pare!',
    'STOP',
    'por favor parar',
    'Pode remover meu número',
    'quero descadastrar',
    'Não quero mais receber',
    'nao receber mais',
    'não me mande mais mensagens',
    'unsubscribe',
    'opt-out',
    'opt out',
    'cancelar',
  ])('detecta "%s"', (text) => {
    expect(isOptOutKeyword(text)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'Oi, tudo bem?',
    'Quero saber o preço',
    'vou comparecer amanhã', // "pare" dentro de outra palavra
    'o produto sairá do estoque?', // "sair" dentro de outra palavra
    'quero a remoção do pelo', // não é "remover"
    'parabéns pelo trabalho', // "parar" ≠ "parab..."
    'cancelamento foi confirmado?', // "cancelar" ≠ "cancelamento"
  ])('não detecta "%s"', (text) => {
    expect(isOptOutKeyword(text)).toBe(false)
  })

  it('aceita entradas não-string sem lançar', () => {
    expect(isOptOutKeyword(null)).toBe(false)
    expect(isOptOutKeyword(undefined)).toBe(false)
    expect(isOptOutKeyword(123)).toBe(false)
  })
})

describe('phoneStorageVariants', () => {
  it('gera variações com e sem "+" a partir do número da Meta (sem +)', () => {
    expect(phoneStorageVariants('5511999990000')).toEqual(['+5511999990000', '5511999990000'])
  })

  it('aceita E.164 com "+"', () => {
    expect(phoneStorageVariants('+5511999990000')).toEqual(['+5511999990000', '5511999990000'])
  })

  it('vazio → []', () => {
    expect(phoneStorageVariants('')).toEqual([])
  })
})

describe('applyInboundOptOut', () => {
  beforeEach(() => {
    mocks.supabase.current = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('grava supressão E marca o contato como OPT_OUT (status que o painel/contador usam)', async () => {
    const fake = createOptOutFake({ contactPhones: ['+5511999990000'] })
    mocks.supabase.current = fake

    const result = await applyInboundOptOut({
      phoneRaw: '5511999990000', // formato que a Meta envia (sem "+")
      source: 'inbound_keyword',
      reason: 'Usuário solicitou opt-out via mensagem inbound',
      metadata: { text: 'Sair' },
    })

    expect(result).toEqual({ phone: '+5511999990000', suppressed: true, contactsUpdated: 1 })

    expect(fake.upserts).toHaveLength(1)
    expect(fake.upserts[0]).toMatchObject({
      table: 'phone_suppressions',
      payload: { phone: '+5511999990000', is_active: true, source: 'inbound_keyword', metadata: { text: 'Sair' } },
      options: { onConflict: 'phone' },
    })

    expect(fake.updates).toHaveLength(1)
    expect(fake.updates[0]).toMatchObject({
      table: 'contacts',
      column: 'phone',
      values: ['+5511999990000', '5511999990000'],
      payload: { status: 'Opt-out' },
    })
    expect(typeof fake.updates[0].payload.updated_at).toBe('string')
  })

  it('atualiza o status mesmo se a supressão falhar (e vice-versa)', async () => {
    const fake1 = createOptOutFake({ contactPhones: ['+5511999990000'], upsertError: { message: 'boom' } })
    mocks.supabase.current = fake1
    expect(await applyInboundOptOut({ phoneRaw: '+5511999990000', source: 's', reason: 'r' })).toEqual({
      phone: '+5511999990000',
      suppressed: false,
      contactsUpdated: 1,
    })

    const fake2 = createOptOutFake({ contactPhones: ['+5511999990000'], updateError: { message: 'boom' } })
    mocks.supabase.current = fake2
    expect(await applyInboundOptOut({ phoneRaw: '+5511999990000', source: 's', reason: 'r' })).toEqual({
      phone: '+5511999990000',
      suppressed: true,
      contactsUpdated: 0,
    })
  })

  it('não lança quando o telefone não existe em contacts (só suprime)', async () => {
    const fake = createOptOutFake({ contactPhones: [] })
    mocks.supabase.current = fake

    const result = await applyInboundOptOut({ phoneRaw: '+5511999990000', source: 's', reason: 'r' })

    expect(result).toEqual({ phone: '+5511999990000', suppressed: true, contactsUpdated: 0 })
  })

  it('telefone vazio → não toca no banco', async () => {
    const fake = createOptOutFake()
    mocks.supabase.current = fake

    const result = await applyInboundOptOut({ phoneRaw: '', source: 's', reason: 'r' })

    expect(result).toEqual({ phone: '', suppressed: false, contactsUpdated: 0 })
    expect(fake.upserts).toHaveLength(0)
    expect(fake.updates).toHaveLength(0)
  })
})
