/**
 * Redis em memória para testes (subset da API do @upstash/redis).
 *
 * Imita a (de)serialização automática do SDK da Upstash: objetos/números são
 * armazenados como JSON e desserializados no `get`.
 *
 * @example
 * ```ts
 * const { fakeRedis } = vi.hoisted(() => ({ fakeRedis: new FakeRedis() }))
 * vi.mock('@/lib/redis', () => ({ redis: fakeRedis, isRedisConfigured: () => true }))
 * ```
 */

interface Entry {
  raw: string
  expiresAt: number | null
}

export class FakeRedis {
  private store = new Map<string, Entry>()

  /** Quando true, toda operação lança erro (simula Redis fora do ar). */
  failing = false

  /** Contadores de chamadas por comando (para asserções). */
  calls: Record<'get' | 'set' | 'setex' | 'del', number> = { get: 0, set: 0, setex: 0, del: 0 }

  now: () => number = () => Date.now()

  private assertUp() {
    if (this.failing) throw new Error('FakeRedis: connection refused')
  }

  private serialize(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  private deserialize<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as unknown as T
    }
  }

  private live(key: string): Entry | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return null
    }
    return entry
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.assertUp()
    this.calls.get++
    const entry = this.live(key)
    return entry ? this.deserialize<T>(entry.raw) : null
  }

  async set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number }
  ): Promise<'OK' | null> {
    this.assertUp()
    this.calls.set++
    if (opts?.nx && this.live(key)) return null
    this.store.set(key, {
      raw: this.serialize(value),
      expiresAt: opts?.ex ? this.now() + opts.ex * 1000 : null,
    })
    return 'OK'
  }

  async setex(key: string, seconds: number, value: unknown): Promise<'OK'> {
    this.assertUp()
    this.calls.setex++
    this.store.set(key, { raw: this.serialize(value), expiresAt: this.now() + seconds * 1000 })
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    this.assertUp()
    this.calls.del++
    let removed = 0
    for (const key of keys) {
      if (this.store.delete(key)) removed++
    }
    return removed
  }

  /** Acesso direto para asserções (sem contar como chamada). */
  peek<T = unknown>(key: string): T | null {
    const entry = this.live(key)
    return entry ? this.deserialize<T>(entry.raw) : null
  }

  has(key: string): boolean {
    return this.live(key) !== null
  }

  keys(): string[] {
    return [...this.store.keys()].filter((k) => this.live(k) !== null)
  }

  clear() {
    this.store.clear()
    this.failing = false
    this.calls = { get: 0, set: 0, setex: 0, del: 0 }
  }
}
