// @vitest-environment node
/**
 * Tela de Contatos (RSC): o filtro de tags e os contadores precisam cobrir TODOS
 * os contatos, não só a primeira página devolvida pelo PostgREST (max-rows).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { supabase: { current: null as unknown } },
}))

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => mocks.supabase.current,
  supabase: {
    from: (table: string) => (mocks.supabase.current as any).from(table),
    rpc: (name: string, args?: unknown) => (mocks.supabase.current as any).rpc(name, args),
  },
}))
// `cache()` do React só funciona dentro de render RSC; em teste vira identidade.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, cache: <T,>(fn: T) => fn }
})

import { buildFakeContacts, createFakePostgrestPager } from '@/tests/helpers/fake-postgrest-pager'
import { getContactsInitialData } from './actions'

describe('getContactsInitialData', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('lista TODAS as tags (inclusive as que só existem após a 1ª página) e conta opt-out no banco inteiro', async () => {
    const contacts = buildFakeContacts(2600, (i) => {
      if (i < 20) return { tags: ['antiga'] }
      if (i >= 1100 && i < 1150) return { tags: ['lote-2026-10-30'], status: 'OPT_OUT' } // 2ª página
      if (i === 2599) return { tags: ['ultima'] }
      return { tags: i % 2 === 0 ? [] : null }
    })
    mocks.supabase.current = createFakePostgrestPager({
      contacts,
      custom_field_definitions: [],
      phone_suppressions: [{ id: 's1', phone: contacts[2000].phone, is_active: true, expires_at: null }],
    })

    const data = await getContactsInitialData()

    expect(data.tags).toEqual(['antiga', 'lote-2026-10-30', 'ultima'])
    expect(data.stats).toEqual({
      total: 2600,
      active: 2600 - 50 - 1,
      optOut: 50,
      suppressed: 1,
    })
    expect(data.contacts).toHaveLength(50) // primeira página da tabela (PAGINATION.contacts)
    expect(data.total).toBe(2600)
  })

  it('funciona quando o servidor trunca em 100 linhas', async () => {
    mocks.supabase.current = createFakePostgrestPager(
      {
        contacts: buildFakeContacts(350, (i) => ({ tags: i >= 300 ? ['nova'] : [], status: i >= 340 ? 'OPT_OUT' : 'OPT_IN' })),
        custom_field_definitions: [],
        phone_suppressions: [],
      },
      { maxRows: 100 }
    )

    const data = await getContactsInitialData()

    expect(data.tags).toEqual(['nova'])
    expect(data.stats.total).toBe(350)
    expect(data.stats.optOut).toBe(10)
  })
})
