import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockCookieSet = vi.fn()
const mockCookieGet = vi.fn()

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: mockCookieGet,
    set: mockCookieSet,
    delete: vi.fn(),
  })),
}))

const mockIsSupabaseConfigured = vi.fn(() => true)
const mockFrom = vi.fn()

vi.mock('./supabase', () => ({
  isSupabaseConfigured: () => mockIsSupabaseConfigured(),
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

type QueryResult = { data: unknown; error: { message: string } | null }

function createSettingsChain(handlers: {
  single?: QueryResult
  upsert?: QueryResult
  delete?: QueryResult
}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(handlers.single ?? { data: null, error: null }),
    upsert: vi.fn().mockResolvedValue(handlers.upsert ?? { data: null, error: null }),
    delete: vi.fn().mockReturnThis(),
  }
  chain.delete = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue(handlers.delete ?? { data: null, error: null }),
  })
  return chain
}

describe('user-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSupabaseConfigured.mockReturnValue(true)
    mockCookieGet.mockReturnValue(undefined)
    delete process.env.SETUP_COMPLETE
    delete process.env.MASTER_PASSWORD
  })

  afterEach(() => {
    vi.resetModules()
  })

  describe('isSetupComplete', () => {
    it('retorna true quando SETUP_COMPLETE=true', async () => {
      process.env.SETUP_COMPLETE = 'true'
      const { isSetupComplete } = await import('./user-auth')
      await expect(isSetupComplete()).resolves.toBe(true)
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('retorna true quando company_name existe no banco', async () => {
      mockFrom.mockReturnValue(
        createSettingsChain({
          single: { data: { key: 'company_name', value: 'Acme' }, error: null },
        })
      )

      const { isSetupComplete } = await import('./user-auth')
      await expect(isSetupComplete()).resolves.toBe(true)
    })
  })

  describe('loginUser', () => {
    it('retorna erro quando MASTER_PASSWORD não está configurada', async () => {
      const { loginUser } = await import('./user-auth')
      const result = await loginUser('qualquer')
      expect(result.success).toBe(false)
      expect(result.error).toContain('MASTER_PASSWORD')
    })

    it('retorna senha incorreta para texto puro', async () => {
      process.env.MASTER_PASSWORD = 'senha-correta'

      mockFrom.mockImplementation(() =>
        createSettingsChain({
          single: { data: null, error: null },
        })
      )

      const { loginUser } = await import('./user-auth')
      const result = await loginUser('senha-errada')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Senha incorreta')
    })

    it('cria sessão com senha correta (texto puro)', async () => {
      process.env.MASTER_PASSWORD = 'senha-correta'

      mockFrom.mockImplementation(() =>
        createSettingsChain({
          single: { data: null, error: null },
          upsert: { data: null, error: null },
          delete: { data: null, error: null },
        })
      )

      const { loginUser } = await import('./user-auth')
      const result = await loginUser('senha-correta')

      expect(result.success).toBe(true)
      expect(mockCookieSet).toHaveBeenCalledWith(
        'smartzap_session',
        expect.any(String),
        expect.objectContaining({ httpOnly: true, path: '/' })
      )
    })

    it('retorna erro específico quando Supabase não está configurado', async () => {
      process.env.MASTER_PASSWORD = 'senha-correta'
      mockIsSupabaseConfigured.mockReturnValue(false)

      mockFrom.mockImplementation(() =>
        createSettingsChain({
          single: { data: null, error: null },
          delete: { data: null, error: null },
        })
      )

      const { loginUser } = await import('./user-auth')
      const result = await loginUser('senha-correta')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Banco de dados não configurado')
    })

    it('retorna erro específico quando falha ao persistir sessão', async () => {
      process.env.MASTER_PASSWORD = 'senha-correta'

      mockFrom.mockImplementation(() =>
        createSettingsChain({
          single: { data: null, error: null },
          upsert: { data: null, error: { message: 'permission denied' } },
          delete: { data: null, error: null },
        })
      )

      const { loginUser } = await import('./user-auth')
      const result = await loginUser('senha-correta')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Falha ao persistir sessão')
    })
  })
})
