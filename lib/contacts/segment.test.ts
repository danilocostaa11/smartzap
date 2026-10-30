// @vitest-environment node
/**
 * Regressão do bug do passo "Público" do assistente de campanha:
 * a lista de destinatários / contagem / tags era montada a partir de UMA página
 * do PostgREST (max-rows), então contatos além da primeira página nunca eram
 * validados nem recebiam a campanha. Estes testes exercitam >100 e >1000
 * contatos com um fake que trunca cada resposta como o Supabase faz.
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

import {
  buildFakeContacts,
  createFakePostgrestPager,
  type FakeContactRow,
} from '@/tests/helpers/fake-postgrest-pager'
import {
  collectDistinctTagsFromContacts,
  contactMatchesSegment,
  countSegmentContacts,
  fetchAllRows,
  normalizeSegmentFilters,
  parseCombineMode,
  parseSegmentList,
  resolveSegmentContacts,
  shouldApplyTagFilterInSql,
} from './segment'

const useContacts = (contacts: FakeContactRow[], maxRows?: number) => {
  const fake = createFakePostgrestPager({ contacts }, { maxRows })
  mocks.supabase.current = fake
  return fake
}

/** Índices "espalhados" pelo dataset: início, meio da 1ª página, 2ª página, 3ª página... */
const SPREAD_INDEXES = [3, 57, 99, 100, 101, 450, 999, 1000, 1001, 1777, 2499]

describe('lib/contacts/segment — fetchAllRows', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('lê todas as linhas quando há mais de 1000 (max-rows padrão do Supabase)', async () => {
    const fake = useContacts(buildFakeContacts(2500))

    const { rows, count } = await fetchAllRows<FakeContactRow>((page) =>
      fake.from('contacts').select('id', page === 0 ? { count: 'exact' } : undefined) as any
    )

    expect(rows).toHaveLength(2500)
    expect(count).toBe(2500)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500)
    // 3 páginas de 1000 (a última parcial); o count da 1ª página evita a 4ª requisição vazia.
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests.map((r) => [r.from, r.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('avança pelo número REAL de linhas devolvidas quando o servidor trunca em 100', async () => {
    // Projetos Supabase podem ter max-rows menor que a página pedida (1000).
    const fake = useContacts(buildFakeContacts(350), 100)

    const { rows } = await fetchAllRows<FakeContactRow>((page) =>
      fake.from('contacts').select('id', page === 0 ? { count: 'exact' } : undefined) as any
    )

    expect(rows).toHaveLength(350)
    expect(new Set(rows.map((r) => r.id)).size).toBe(350)
    expect(fake.requests).toHaveLength(4) // 100 + 100 + 100 + 50
  })

  it('sem count, para ao receber uma página vazia (não entra em loop)', async () => {
    const fake = useContacts(buildFakeContacts(1500))

    const { rows, count } = await fetchAllRows<FakeContactRow>(() => fake.from('contacts').select('id') as any)

    expect(rows).toHaveLength(1500)
    expect(count).toBeNull()
    expect(fake.requests).toHaveLength(3) // 1000 + 500 + página vazia
  })

  it('retorna vazio para tabela vazia', async () => {
    const fake = useContacts([])
    const { rows } = await fetchAllRows<FakeContactRow>(() =>
      fake.from('contacts').select('id', { count: 'exact' }) as any
    )
    expect(rows).toEqual([])
    expect(fake.requests).toHaveLength(1)
  })
})

describe('lib/contacts/segment — resolveSegmentContacts', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('modo "todos" (sem filtros) devolve TODOS os contatos, não só a primeira página', async () => {
    useContacts(buildFakeContacts(2345))

    const contacts = await resolveSegmentContacts({ tags: [], countries: [], states: [], combine: 'or' })

    expect(contacts).toHaveLength(2345)
    expect(contacts[0]).toMatchObject({
      id: 'c-000000',
      name: 'Contato 0',
      phone: '+5511900000000',
      email: null,
      status: 'OPT_IN',
      tags: [],
      custom_fields: {},
    })
  })

  it('tag com 8 contatos espalhados em >100 linhas: devolve os 8 (regressão lote8-lista3)', async () => {
    // Cenário do bug: 8 contatos com a tag, só 5 nas primeiras ~100 linhas.
    const tagged = new Set([2, 10, 40, 77, 95, 130, 210, 333])
    useContacts(
      buildFakeContacts(400, (i) => ({ tags: tagged.has(i) ? ['lote8-lista3'] : ['outra'] })),
      100 // servidor devolvendo só 100 por resposta
    )

    const contacts = await resolveSegmentContacts({ tags: ['lote8-lista3'], countries: [], states: [], combine: 'or' })

    expect(contacts.map((c) => c.id).sort()).toEqual(
      Array.from(tagged)
        .map((i) => `c-${String(i).padStart(6, '0')}`)
        .sort()
    )
  })

  it('tag espalhada em >1000 contatos (OR, filtro no SQL): devolve todos os marcados', async () => {
    const tagged = new Set(SPREAD_INDEXES)
    useContacts(buildFakeContacts(2600, (i) => ({ tags: tagged.has(i) ? ['lote8-resto', 'x'] : ['x'] })))

    const contacts = await resolveSegmentContacts({ tags: ['lote8-resto'], countries: [], states: [], combine: 'or' })

    expect(contacts).toHaveLength(SPREAD_INDEXES.length)
    expect(contacts.every((c) => c.tags.includes('lote8-resto'))).toBe(true)
  })

  it('OR com várias tags devolve a união (sem duplicar)', async () => {
    useContacts(
      buildFakeContacts(1200, (i) => ({
        tags: i % 2 === 0 ? ['a'] : i % 3 === 0 ? ['b'] : i % 5 === 0 ? ['a', 'b'] : [],
      }))
    )

    const contacts = await resolveSegmentContacts({ tags: ['a', 'b'], countries: [], states: [], combine: 'or' })

    const expected = Array.from({ length: 1200 }, (_, i) => i).filter((i) => i % 2 === 0 || i % 3 === 0 || i % 5 === 0)
    expect(contacts).toHaveLength(expected.length)
    expect(new Set(contacts.map((c) => c.id)).size).toBe(expected.length)
  })

  it('AND com várias tags devolve só quem tem todas', async () => {
    useContacts(buildFakeContacts(1500, (i) => ({ tags: i % 7 === 0 ? ['a', 'b'] : i % 2 === 0 ? ['a'] : ['b'] })))

    const contacts = await resolveSegmentContacts({ tags: ['a', 'b'], countries: [], states: [], combine: 'and' })

    expect(contacts).toHaveLength(Math.floor(1499 / 7) + 1)
    expect(contacts.every((c) => c.tags.includes('a') && c.tags.includes('b'))).toBe(true)
  })

  it('tag + UF (filtro de localização em memória) em >1000 contatos', async () => {
    // DDD 21 = RJ para índices múltiplos de 3; tag "vip" para múltiplos de 4.
    useContacts(
      buildFakeContacts(1800, (i) => ({
        phone: i % 3 === 0 ? `+5521${String(900000000 + i).padStart(9, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
        tags: i % 4 === 0 ? ['vip'] : [],
      }))
    )

    const andResult = await resolveSegmentContacts({ tags: ['vip'], countries: [], states: ['RJ'], combine: 'and' })
    const expectedAnd = Array.from({ length: 1800 }, (_, i) => i).filter((i) => i % 3 === 0 && i % 4 === 0)
    expect(andResult).toHaveLength(expectedAnd.length)
    expect(andResult.at(-1)?.id).toBe(`c-${String(expectedAnd.at(-1)).padStart(6, '0')}`)

    const orResult = await resolveSegmentContacts({ tags: ['vip'], countries: [], states: ['RJ'], combine: 'or' })
    const expectedOr = Array.from({ length: 1800 }, (_, i) => i).filter((i) => i % 3 === 0 || i % 4 === 0)
    expect(orResult).toHaveLength(expectedOr.length)
  })

  it('tag com caracteres "não seguros" NÃO é descartada: filtra em memória', async () => {
    // Antes, a tag era removida do filtro e o segmento virava "todos os contatos".
    const fake = useContacts(buildFakeContacts(1100, (i) => ({ tags: i % 50 === 0 ? ['vip!', 'z'] : ['z'] })))

    const contacts = await resolveSegmentContacts({ tags: ['vip!'], countries: [], states: [], combine: 'or' })

    expect(contacts).toHaveLength(22)
    expect(contacts.every((c) => c.tags.includes('vip!'))).toBe(true)
    // Nenhum filtro `or()`/`cs` chegou ao SQL com a tag perigosa.
    expect(fake.requests.every((r) => r.filters.length === 0)).toBe(true)
  })

  it('sanitiza tags corrompidas (não-string) e custom_fields nulo', async () => {
    useContacts([
      { id: 'a', name: 'A', phone: '+5511999999999', tags: ['ok', 42, null, ''], custom_fields: null },
    ])

    const contacts = await resolveSegmentContacts(null)

    expect(contacts).toEqual([
      {
        id: 'a',
        name: 'A',
        phone: '+5511999999999',
        email: null,
        status: null,
        tags: ['ok'],
        custom_fields: {},
      },
    ])
  })
})

describe('lib/contacts/segment — countSegmentContacts', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('sem localização usa count exato do SQL (HEAD) e não carrega linhas', async () => {
    const fake = useContacts(buildFakeContacts(3000, (i) => ({ tags: i % 10 === 0 ? ['dez'] : [] })))

    const result = await countSegmentContacts({ tags: ['dez'], countries: [], states: [], combine: 'or' })

    expect(result).toEqual({ total: 300, matched: 300 })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0].head).toBe(true)
    expect(fake.requests[0].count).toBe(true)
  })

  it('com UF pagina o banco inteiro (>1000) em vez de truncar', async () => {
    const fake = useContacts(
      buildFakeContacts(2200, (i) => ({
        phone: i % 2 === 0 ? `+5521${String(900000000 + i).padStart(9, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
      }))
    )

    const result = await countSegmentContacts({ tags: [], countries: [], states: ['RJ'], combine: 'or' })

    expect(result).toEqual({ total: 2200, matched: 1100 })
    expect(fake.requests.length).toBeGreaterThanOrEqual(3)
  })

  it('OR com tag + país: tags NÃO vão para o SQL (senão elimina quem bate só por país)', async () => {
    const fake = useContacts(
      buildFakeContacts(1200, (i) => ({
        phone: i % 100 === 0 ? `+3519${String(10000000 + i).padStart(8, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
        tags: i % 300 === 0 ? ['pt'] : [],
      }))
    )

    const result = await countSegmentContacts({ tags: ['pt'], countries: ['PT'], states: [], combine: 'or' })

    // Índices múltiplos de 100 (PT) ∪ múltiplos de 300 (tag) = múltiplos de 100 → 12
    expect(result.matched).toBe(12)
    expect(result.total).toBe(1200)
    expect(fake.requests.every((r) => r.filters.length === 0)).toBe(true)
  })
})

describe('lib/contacts/segment — estimativa e validação usam a MESMA consulta', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it.each([
    { label: 'max-rows 1000', maxRows: 1000, total: 1300, firstTagged: 1000 },
    { label: 'max-rows 100', maxRows: 100, total: 400, firstTagged: 100 },
  ])(
    'tag nova em 50 contatos todos além da 1ª página ($label): estimativa = 50 e validação = 50',
    async ({ maxRows, total, firstTagged }) => {
      // Caso de produção: estimativa mostrava 50, mas a Validação dizia
      // "Nenhum contato encontrado para validar" (lista vinha só da 1ª página).
      const TAG = 'lote-2026-10-30'
      const tagged = new Set(Array.from({ length: 50 }, (_, i) => firstTagged + i))
      useContacts(
        buildFakeContacts(total, (i) => ({ tags: tagged.has(i) ? [TAG, 'base'] : ['base'] })),
        maxRows
      )
      const filters = { tags: [TAG], countries: [], states: [], combine: 'or' as const }

      const estimate = await countSegmentContacts(filters)
      const recipients = await resolveSegmentContacts(filters)

      expect(estimate).toEqual({ total: 50, matched: 50 })
      expect(recipients).toHaveLength(estimate.matched)
      expect(recipients.map((c) => c.id)).toEqual(
        Array.from(tagged).map((i) => `c-${String(i).padStart(6, '0')}`)
      )
      // Sanidade: a abordagem antiga (1ª página + filtro no cliente) daria 0.
      const firstPageOnly = buildFakeContacts(total, (i) => ({ tags: tagged.has(i) ? [TAG] : [] }))
        .slice(0, maxRows)
        .filter((c) => (c.tags as string[]).includes(TAG))
      expect(firstPageOnly).toHaveLength(0)
    }
  )

  it('com filtro de UF, contagem e lista continuam iguais em >1000 contatos', async () => {
    useContacts(
      buildFakeContacts(2100, (i) => ({
        phone: i % 5 === 0 ? `+5521${String(900000000 + i).padStart(9, '0')}` : `+5511${String(900000000 + i).padStart(9, '0')}`,
        tags: i % 7 === 0 ? ['promo'] : [],
      }))
    )
    const filters = { tags: ['promo'], countries: ['BR'], states: ['RJ'], combine: 'and' as const }

    const estimate = await countSegmentContacts(filters)
    const recipients = await resolveSegmentContacts(filters)

    expect(estimate.matched).toBe(recipients.length)
    expect(estimate.matched).toBe(Array.from({ length: 2100 }, (_, i) => i).filter((i) => i % 35 === 0).length)
  })
})

describe('lib/contacts/segment — collectDistinctTagsFromContacts', () => {
  beforeEach(() => {
    mocks.supabase.current = null
  })

  it('agrega tags de TODOS os contatos, inclusive as que só existem após a 1ª página', async () => {
    useContacts(
      buildFakeContacts(2500, (i) => {
        if (i < 50) return { tags: ['lote1', 'lote2', 'lote3', 'lote4', 'lote5', 'lote6'] }
        if (i >= 1200 && i < 1203) return { tags: ['lote8-resto'] } // só 3 contatos, na 2ª página
        if (i === 2499) return { tags: ['ultima'] }
        if (i % 2 === 0) return { tags: null }
        return { tags: [] }
      })
    )

    const tags = await collectDistinctTagsFromContacts()

    expect(tags).toEqual(['lote1', 'lote2', 'lote3', 'lote4', 'lote5', 'lote6', 'lote8-resto', 'ultima'])
  })

  it('ignora tags vazias/whitespace e arrays serializados', async () => {
    useContacts([
      { id: '1', tags: ['ok', '  ', '', '["corrompida"]', 7] },
      { id: '2', tags: [' ok '] },
    ])

    expect(await collectDistinctTagsFromContacts()).toEqual(['ok'])
  })
})

describe('lib/contacts/segment — helpers puros', () => {
  it('parseSegmentList separa por vírgula, trim e dedup', () => {
    expect(parseSegmentList(' a, b ,,a ')).toEqual(['a', 'b'])
    expect(parseSegmentList(null)).toEqual([])
  })

  it('parseCombineMode só aceita and/or', () => {
    expect(parseCombineMode('AND')).toBe('and')
    expect(parseCombineMode('xpto')).toBe('or')
    expect(parseCombineMode(null)).toBe('or')
  })

  it('normalizeSegmentFilters padroniza país/UF em maiúsculas', () => {
    expect(normalizeSegmentFilters({ tags: [' t '], countries: ['br'], states: ['sp', 'SP'] })).toEqual({
      tags: ['t'],
      countries: ['BR'],
      states: ['SP'],
      combine: 'or',
    })
  })

  it('shouldApplyTagFilterInSql segue as regras de segurança/semântica', () => {
    const base = { countries: [], states: [] }
    expect(shouldApplyTagFilterInSql({ ...base, tags: [], combine: 'or' })).toBe(false)
    expect(shouldApplyTagFilterInSql({ ...base, tags: ['lote8-resto'], combine: 'or' })).toBe(true)
    expect(shouldApplyTagFilterInSql({ ...base, tags: ['a', 'b'], combine: 'and' })).toBe(true)
    // OR + localização → em memória
    expect(shouldApplyTagFilterInSql({ tags: ['a'], countries: ['BR'], states: [], combine: 'or' })).toBe(false)
    // AND + localização → SQL (só reduz)
    expect(shouldApplyTagFilterInSql({ tags: ['a'], countries: ['BR'], states: [], combine: 'and' })).toBe(true)
    // tag insegura → em memória
    expect(shouldApplyTagFilterInSql({ ...base, tags: ['a,b'], combine: 'or' })).toBe(false)
  })

  it('contactMatchesSegment respeita AND/OR e o flag de tags já filtradas', () => {
    const contact = { phone: '+5521999999999', tags: ['a'] }
    expect(contactMatchesSegment(contact, { tags: ['b'], countries: [], states: ['RJ'], combine: 'or' }, false)).toBe(true)
    expect(contactMatchesSegment(contact, { tags: ['b'], countries: [], states: ['RJ'], combine: 'and' }, false)).toBe(false)
    expect(contactMatchesSegment(contact, { tags: ['b'], countries: [], states: ['RJ'], combine: 'and' }, true)).toBe(true)
    expect(contactMatchesSegment(contact, { tags: [], countries: [], states: [], combine: 'and' }, false)).toBe(true)
  })
})
