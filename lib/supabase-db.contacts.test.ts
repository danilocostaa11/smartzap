// @vitest-environment node
/**
 * contactDb: "todos os contatos" e "todas as tags" precisam cobrir o banco
 * inteiro, mesmo quando o PostgREST trunca cada resposta (max-rows) ou quando o
 * RPC agregado ainda não foi aplicado no projeto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { supabase: { current: null as unknown } },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => (mocks.supabase.current as any).from(table),
    rpc: (name: string, args?: unknown) => (mocks.supabase.current as any).rpc(name, args),
  },
}))
vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => (mocks.supabase.current as any).from(table),
    rpc: (name: string, args?: unknown) => (mocks.supabase.current as any).rpc(name, args),
  },
}))
vi.mock('./redis', () => ({ redis: null, isRedisConfigured: () => false }))

import { buildFakeContacts, createFakePostgrestPager } from '@/tests/helpers/fake-postgrest-pager'
import { contactDb } from './supabase-db'

describe('contactDb.getAll', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('devolve todos os contatos quando há mais de 1000', async () => {
    const fake = createFakePostgrestPager({ contacts: buildFakeContacts(2750) })
    mocks.supabase.current = fake

    const contacts = await contactDb.getAll()

    expect(contacts).toHaveLength(2750)
    expect(new Set(contacts.map((c) => c.id)).size).toBe(2750)
    expect(fake.requests.length).toBeGreaterThanOrEqual(3)
  })

  it('devolve todos os contatos quando o servidor trunca em 100 linhas', async () => {
    mocks.supabase.current = createFakePostgrestPager({ contacts: buildFakeContacts(230) }, { maxRows: 100 })

    const contacts = await contactDb.getAll()

    expect(contacts).toHaveLength(230)
  })

  it('mantém ordenação por created_at desc (mais recentes primeiro)', async () => {
    mocks.supabase.current = createFakePostgrestPager({ contacts: buildFakeContacts(1200) })

    const contacts = await contactDb.getAll()

    expect(contacts[0].id).toBe('c-001199')
    expect(contacts.at(-1)?.id).toBe('c-000000')
  })
})

describe('contactDb.getTags', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('usa o RPC get_contact_tags quando disponível', async () => {
    const fake = createFakePostgrestPager({ contacts: [] })
    fake.onRpc('get_contact_tags', () => ({ data: ['a', 'b', 'lote8-resto'], error: null }))
    mocks.supabase.current = fake

    expect(await contactDb.getTags()).toEqual(['a', 'b', 'lote8-resto'])
    expect(fake.requests).toHaveLength(0)
  })

  it('sem o RPC, agrega tags de TODOS os contatos (paginado) em vez de falhar', async () => {
    const fake = createFakePostgrestPager({
      contacts: buildFakeContacts(1600, (i) => ({
        tags: i < 10 ? ['base'] : i >= 1500 ? ['lote8-resto'] : [],
      })),
    })
    mocks.supabase.current = fake

    expect(await contactDb.getTags()).toEqual(['base', 'lote8-resto'])
  })

  it('propaga outros erros do RPC', async () => {
    const fake = createFakePostgrestPager({ contacts: [] })
    fake.onRpc('get_contact_tags', () => ({ data: null, error: { code: '42501', message: 'permission denied' } }))
    mocks.supabase.current = fake
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(contactDb.getTags()).rejects.toMatchObject({ code: '42501' })
  })
})
