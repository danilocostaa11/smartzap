// @vitest-environment node
/**
 * GET /api/contacts/segment — resolve o público do assistente de campanha no
 * servidor, cobrindo o banco inteiro (não só a 1ª página do PostgREST).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    supabase: { current: null as unknown },
    requireSessionOrApiKey: vi.fn(),
  },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => (mocks.supabase.current as any).from(table),
    rpc: (name: string, args?: unknown) => (mocks.supabase.current as any).rpc(name, args),
  },
}))
vi.mock('@/lib/request-auth', () => ({
  requireSessionOrApiKey: mocks.requireSessionOrApiKey,
}))

import { NextRequest, NextResponse } from 'next/server'
import { buildFakeContacts, createFakePostgrestPager } from '@/tests/helpers/fake-postgrest-pager'
import { GET as getSegment } from './route'
import { GET as getSegmentCount } from '../segment-count/route'

const request = (params: Record<string, string> = {}, path = '/api/contacts/segment') => {
  const url = new URL(path, 'http://localhost')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers: { cookie: 'smartzap_session=test' } })
}

describe('GET /api/contacts/segment', () => {
  beforeEach(() => {
    mocks.supabase.current = null
    mocks.requireSessionOrApiKey.mockReset()
    mocks.requireSessionOrApiKey.mockResolvedValue(null)
  })

  it('exige sessão ou API key', async () => {
    mocks.requireSessionOrApiKey.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const res = await getSegment(request())

    expect(res.status).toBe(401)
  })

  it('sem filtros devolve TODOS os contatos (>1000) com os campos do wizard', async () => {
    mocks.supabase.current = createFakePostgrestPager({
      contacts: buildFakeContacts(1234, (i) => ({ custom_fields: { idx: i }, email: `c${i}@x.com` })),
    })

    const res = await getSegment(request())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(body.total).toBe(1234)
    expect(body.data).toHaveLength(1234)
    expect(body.data[0]).toEqual({
      id: 'c-000000',
      name: 'Contato 0',
      phone: '+5511900000000',
      email: 'c0@x.com',
      status: 'OPT_IN',
      tags: [],
      custom_fields: { idx: 0 },
    })
  })

  it('filtra por tag no banco inteiro (8 contatos espalhados além da 1ª página)', async () => {
    const tagged = [1, 50, 99, 100, 101, 500, 1000, 1001]
    mocks.supabase.current = createFakePostgrestPager(
      { contacts: buildFakeContacts(1100, (i) => ({ tags: tagged.includes(i) ? ['lote8-lista3'] : [] })) },
      { maxRows: 100 }
    )

    const res = await getSegment(request({ tags: 'lote8-lista3', combine: 'or' }))
    const body = await res.json()

    expect(body.total).toBe(8)
    expect(body.data.map((c: { id: string }) => c.id)).toEqual(tagged.map((i) => `c-${String(i).padStart(6, '0')}`))
  })

  it('aplica combine=and com tags + UF', async () => {
    mocks.supabase.current = createFakePostgrestPager({
      contacts: buildFakeContacts(1500, (i) => ({
        phone: i % 2 === 0 ? `+5521${String(900000000 + i).padStart(9, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
        tags: i % 5 === 0 ? ['vip'] : [],
      })),
    })

    const res = await getSegment(request({ tags: 'vip', states: 'RJ', combine: 'and' }))
    const body = await res.json()

    expect(body.total).toBe(150) // múltiplos de 10
  })

  it('responde 500 com mensagem quando o banco falha', async () => {
    mocks.supabase.current = {
      from: () => {
        throw new Error('boom')
      },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getSegment(request())

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'Falha ao resolver público', details: 'boom' })
  })
})

describe('GET /api/contacts/segment-count', () => {
  beforeEach(() => {
    mocks.supabase.current = null
    mocks.requireSessionOrApiKey.mockReset()
    mocks.requireSessionOrApiKey.mockResolvedValue(null)
  })

  it('conta o segmento no banco inteiro (>1000) e bate com /segment', async () => {
    const dataset = buildFakeContacts(2300, (i) => ({
      phone: i % 3 === 0 ? `+5521${String(900000000 + i).padStart(9, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
      tags: i % 4 === 0 ? ['vip'] : [],
    }))
    mocks.supabase.current = createFakePostgrestPager({ contacts: dataset })

    const countRes = await getSegmentCount(request({ tags: 'vip', states: 'RJ', combine: 'or' }, '/api/contacts/segment-count'))
    const count = await countRes.json()

    const listRes = await getSegment(request({ tags: 'vip', states: 'RJ', combine: 'or' }))
    const list = await listRes.json()

    const expected = Array.from({ length: 2300 }, (_, i) => i).filter((i) => i % 3 === 0 || i % 4 === 0).length
    expect(count).toEqual({ total: 2300, matched: expected })
    expect(list.total).toBe(expected)
  })
})
