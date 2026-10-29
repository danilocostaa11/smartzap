/**
 * Fake do PostgREST focado em PAGINAÇÃO, para testar código que precisa ler o
 * banco inteiro (>1000 linhas) via `.range()`.
 *
 * Simula o comportamento real do Supabase/PostgREST que motiva esses testes:
 *   - cada resposta é truncada em `maxRows` (padrão 1000, como o Supabase);
 *   - `.range(from, to)` recorta a lista já filtrada;
 *   - `select(cols, { count: 'exact' })` devolve `count` do total filtrado;
 *   - `select(cols, { head: true })` devolve `data: null` (só count).
 *
 * Filtros suportados (os usados em lib/contacts/segment.ts):
 *   - `.filter('tags', 'cs', JSON.stringify([...]))` → contains (todas as tags)
 *   - `.or('tags.cs.["a"],tags.cs.["b"]')`          → contém qualquer uma
 *   - `.not('tags', 'is', null)`
 *   - `.eq(column, value)` / `.in(column, values)`
 *   - `.order()` (ignorado: a ordem de inserção é estável)
 */

export interface FakeContactRow {
  id: string
  name?: string
  phone?: string
  email?: string | null
  status?: string | null
  tags?: unknown
  custom_fields?: Record<string, unknown> | null
  created_at?: string
  [key: string]: unknown
}

export interface FakePagerOptions {
  /** Teto de linhas por resposta (PostgREST `max-rows`). Padrão: 1000. */
  maxRows?: number
}

export interface FakeRequestLog {
  table: string
  from: number | null
  to: number | null
  count: boolean
  head: boolean
  filters: string[]
}

type Predicate = (row: FakeContactRow) => boolean

const rowTags = (row: FakeContactRow): string[] =>
  Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : []

class FakePagedQuery implements PromiseLike<{ data: unknown[] | null; error: null; count: number | null }> {
  private predicates: Predicate[] = []
  private rangeFrom: number | null = null
  private rangeTo: number | null = null
  private wantsCount = false
  private headOnly = false
  private filterLog: string[] = []

  constructor(
    private table: string,
    private rows: () => FakeContactRow[],
    private maxRows: number,
    private log: FakeRequestLog[]
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.wantsCount = options?.count === 'exact'
    this.headOnly = Boolean(options?.head)
    return this
  }

  filter(column: string, operator: string, value: string) {
    this.filterLog.push(`${column}.${operator}.${value}`)
    if (column === 'tags' && operator === 'cs') {
      const required = JSON.parse(value) as string[]
      this.predicates.push((row) => {
        const tags = rowTags(row)
        return required.every((t) => tags.includes(t))
      })
      return this
    }
    throw new Error(`FakePagedQuery: filtro não suportado ${column} ${operator}`)
  }

  or(conditions: string) {
    this.filterLog.push(`or(${conditions})`)
    // Formato gerado pelo código: tags.cs.["a"],tags.cs.["b"]
    const parts = conditions.split(/,(?=tags\.cs\.)/)
    const alternatives = parts.map((part) => {
      const match = part.match(/^tags\.cs\.(.+)$/)
      if (!match) throw new Error(`FakePagedQuery: condição OR não suportada: ${part}`)
      return JSON.parse(match[1]) as string[]
    })
    this.predicates.push((row) => {
      const tags = rowTags(row)
      return alternatives.some((required) => required.every((t) => tags.includes(t)))
    })
    return this
  }

  not(column: string, operator: string, value: unknown) {
    this.filterLog.push(`not(${column}.${operator}.${String(value)})`)
    if (operator === 'is' && value === null) {
      this.predicates.push((row) => row[column] !== null && row[column] !== undefined)
      return this
    }
    throw new Error(`FakePagedQuery: not(${operator}) não suportado`)
  }

  eq(column: string, value: unknown) {
    this.filterLog.push(`eq(${column},${String(value)})`)
    this.predicates.push((row) => row[column] === value)
    return this
  }

  in(column: string, values: unknown[]) {
    this.filterLog.push(`in(${column})`)
    const set = new Set(values)
    this.predicates.push((row) => set.has(row[column]))
    return this
  }

  order(_column: string, _options?: { ascending?: boolean }) {
    return this
  }

  range(from: number, to: number) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }

  limit(n: number) {
    this.rangeFrom = this.rangeFrom ?? 0
    this.rangeTo = this.rangeFrom + n - 1
    return this
  }

  private execute() {
    const filtered = this.rows().filter((row) => this.predicates.every((p) => p(row)))
    const count = this.wantsCount ? filtered.length : null

    this.log.push({
      table: this.table,
      from: this.rangeFrom,
      to: this.rangeTo,
      count: this.wantsCount,
      head: this.headOnly,
      filters: [...this.filterLog],
    })

    if (this.headOnly) {
      return { data: null, error: null, count }
    }

    const from = this.rangeFrom ?? 0
    const requestedTo = this.rangeTo ?? Number.POSITIVE_INFINITY
    // PostgREST aplica max-rows sobre o range pedido: devolve no máximo maxRows linhas.
    const to = Math.min(requestedTo, from + this.maxRows - 1)
    const data = filtered.slice(from, to + 1)

    return { data, error: null, count }
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[] | null; error: null; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }
}

export function createFakePostgrestPager(
  tables: Record<string, FakeContactRow[]>,
  options: FakePagerOptions = {}
) {
  const maxRows = Math.max(1, options.maxRows ?? 1000)
  const requests: FakeRequestLog[] = []
  const rpcHandlers: Record<string, () => { data: unknown; error: { code?: string; message: string } | null }> = {}

  const client = {
    from(table: string) {
      const rows = tables[table]
      if (!rows) throw new Error(`FakePostgrestPager: tabela desconhecida ${table}`)
      return new FakePagedQuery(table, () => rows, maxRows, requests)
    },
    async rpc(name: string) {
      const handler = rpcHandlers[name]
      if (!handler) {
        return { data: null, error: { code: '42883', message: `function ${name} does not exist` } }
      }
      return handler()
    },
    /** Registra um RPC fake. */
    onRpc(name: string, handler: () => { data: unknown; error: { code?: string; message: string } | null }) {
      rpcHandlers[name] = handler
    },
    /** Histórico de requisições (para asserções de paginação). */
    requests,
    reset() {
      requests.length = 0
    },
  }

  return client
}

export type FakePostgrestPager = ReturnType<typeof createFakePostgrestPager>

/** Gera `n` contatos; `decorate` permite ajustar tags/telefone por índice. */
export function buildFakeContacts(
  n: number,
  decorate: (index: number) => Partial<FakeContactRow> = () => ({})
): FakeContactRow[] {
  return Array.from({ length: n }, (_, i) => {
    const base: FakeContactRow = {
      id: `c-${String(i).padStart(6, '0')}`,
      name: `Contato ${i}`,
      // DDD 11 (SP) por padrão; sufixo único por índice
      phone: `+5511${String(900000000 + i).padStart(9, '0')}`,
      email: null,
      status: 'OPT_IN',
      tags: [],
      custom_fields: {},
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }
    return { ...base, ...decorate(i) }
  })
}
