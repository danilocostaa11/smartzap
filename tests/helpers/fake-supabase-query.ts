/**
 * Fake mínimo e encadeável do client Supabase para testes de unidade.
 *
 * Em vez de reproduzir o PostgREST, cada tabela recebe um handler que recebe a
 * "query" acumulada (operação, filtros, payload, colunas) e devolve `{ data, error }`.
 *
 * Suporta: from().select()/update()/insert()/delete(), eq/is/neq/in/order/limit/lt,
 * single()/maybeSingle() e `await` direto (thenable). Também `rpc(name, args)`.
 *
 * @example
 * ```ts
 * const supabase = createFakeSupabase({
 *   tables: {
 *     ai_agents: ({ filters }) => ({ data: { id: 'agent-1', debounce_ms: 8000 }, error: null }),
 *   },
 *   rpc: {
 *     get_agent_config: () => ({ data: { ai_agent_id: null, debounce_ms: 3000 }, error: null }),
 *   },
 * })
 * ```
 */

export type FakeQueryOp = 'select' | 'update' | 'insert' | 'delete'

export interface FakeQuery {
  table: string
  op: FakeQueryOp
  columns: string | null
  payload: unknown
  filters: Array<{ type: string; column: string; value: unknown }>
  limit: number | null
  single: 'single' | 'maybeSingle' | null
}

export interface FakeResult<T = unknown> {
  data: T | null
  error: { code?: string; message: string } | null
}

export type TableHandler = (query: FakeQuery) => FakeResult | Promise<FakeResult>
export type RpcHandler = (args: Record<string, unknown>) => FakeResult | Promise<FakeResult>

export interface FakeSupabaseOptions {
  tables?: Record<string, TableHandler>
  rpc?: Record<string, RpcHandler>
}

class FakeQueryBuilder {
  private query: FakeQuery

  constructor(
    table: string,
    private handler: TableHandler | undefined,
    private log: FakeQuery[]
  ) {
    this.query = {
      table,
      op: 'select',
      columns: null,
      payload: null,
      filters: [],
      limit: null,
      single: null,
    }
  }

  select(columns: string = '*') {
    // select() depois de update()/insert() apenas define colunas de retorno
    if (this.query.op === 'select') this.query.op = 'select'
    this.query.columns = columns
    return this
  }

  update(payload: unknown) {
    this.query.op = 'update'
    this.query.payload = payload
    return this
  }

  insert(payload: unknown) {
    this.query.op = 'insert'
    this.query.payload = payload
    return this
  }

  delete() {
    this.query.op = 'delete'
    return this
  }

  private filter(type: string, column: string, value: unknown) {
    this.query.filters.push({ type, column, value })
    return this
  }

  eq(column: string, value: unknown) {
    return this.filter('eq', column, value)
  }

  neq(column: string, value: unknown) {
    return this.filter('neq', column, value)
  }

  is(column: string, value: unknown) {
    return this.filter('is', column, value)
  }

  in(column: string, value: unknown) {
    return this.filter('in', column, value)
  }

  lt(column: string, value: unknown) {
    return this.filter('lt', column, value)
  }

  order(_column: string, _opts?: unknown) {
    return this
  }

  limit(n: number) {
    this.query.limit = n
    return this
  }

  single() {
    this.query.single = 'single'
    return this.execute()
  }

  maybeSingle() {
    this.query.single = 'maybeSingle'
    return this.execute()
  }

  private async execute(): Promise<FakeResult> {
    this.log.push({ ...this.query, filters: [...this.query.filters] })
    if (!this.handler) {
      return { data: null, error: { code: '42P01', message: `FakeSupabase: no handler for table ${this.query.table}` } }
    }
    const result = await this.handler(this.query)
    if (this.query.single === 'single' && result.data === null && !result.error) {
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    }
    return result
  }

  // Permite `await supabase.from(...).update(...).eq(...)` sem single()
  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const queries: FakeQuery[] = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

  const client = {
    from(table: string) {
      return new FakeQueryBuilder(table, options.tables?.[table], queries)
    },
    async rpc(name: string, args: Record<string, unknown> = {}): Promise<FakeResult> {
      rpcCalls.push({ name, args })
      const handler = options.rpc?.[name]
      if (!handler) {
        return { data: null, error: { code: '42883', message: `function ${name} does not exist` } }
      }
      return handler(args)
    },
    /** Histórico de queries executadas (para asserções). */
    queries,
    /** Histórico de RPCs chamadas (para asserções). */
    rpcCalls,
    reset() {
      queries.length = 0
      rpcCalls.length = 0
    },
  }

  return client
}

export type FakeSupabaseClient = ReturnType<typeof createFakeSupabase>
