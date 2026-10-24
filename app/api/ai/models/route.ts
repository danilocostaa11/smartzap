import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { AI_PROVIDERS } from '@/lib/ai/providers'

export interface AIModelInfo {
  id: string
  name: string
  provider: 'google' | 'openai' | 'opencode_go'
  /** true = alias auto-atualizado (ex: gemini-flash-latest) */
  isAlias: boolean
}

/** OpenCode Go não tem endpoint de listagem — usa o catálogo estático. */
function getOpenCodeGoModels(): AIModelInfo[] {
  const provider = AI_PROVIDERS.find((p) => p.id === 'opencode_go')
  return (provider?.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    provider: 'opencode_go' as const,
    isAlias: false,
  }))
}

// Padrões de modelos a excluir do fetch do Google
const GOOGLE_EXCLUDED_PATTERNS = [
  'tts', 'image', 'robotics', 'computer-use', 'deep-research',
  'lyria', 'gemma', 'nano-banana', 'embedding', 'aqa',
]

// Padrões de modelos a excluir do fetch da OpenAI
const OPENAI_EXCLUDED_PATTERNS = [
  'audio', 'image', 'realtime', 'search', 'codex', 'deep-research',
  'embedding', 'tts', 'whisper', 'davinci', 'babbage', 'moderation',
  'transcribe', 'preview', 'instruct',
]

// IDs com sufixo de data completo (ex: gpt-4o-2024-08-06)
const DATE_SUFFIX_RE = /\d{4}-\d{2}-\d{2}$/
// IDs com sufixo MMDD legado (ex: gpt-4-0613, gpt-4-1106-preview)
const MMDD_SUFFIX_RE = /\d{4}$/

function isGoogleExcluded(id: string): boolean {
  return GOOGLE_EXCLUDED_PATTERNS.some((p) => id.includes(p))
}

function isOpenAIExcluded(id: string): boolean {
  return OPENAI_EXCLUDED_PATTERNS.some((p) => id.includes(p))
}

async function getSettingValue(key: string): Promise<string | null> {
  const { data, error } = await supabase.admin
    ?.from('settings')
    .select('value')
    .eq('key', key)
    .single() || { data: null, error: null }
  if (error || !data) return null
  return data.value
}

async function fetchGoogleModels(apiKey: string): Promise<AIModelInfo[]> {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': apiKey } }
  )
  if (!res.ok) throw new Error(`Google API error: HTTP ${res.status}`)

  const data = await res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: AIModelInfo[] = (data.models ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => {
      const id: string = m.name.replace('models/', '')
      return (
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        !isGoogleExcluded(id)
      )
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => {
      const id: string = m.name.replace('models/', '')
      return {
        id,
        name: m.displayName || id,
        provider: 'google' as const,
        isAlias: id.endsWith('-latest'),
      }
    })

  // Aliases primeiro (sempre atualizados), depois versões fixas mais recente → mais antigo
  const aliases = all.filter((m) => m.isAlias)
  const pinned = all
    .filter((m) => !m.isAlias)
    .sort((a, b) => b.id.localeCompare(a.id))

  return [...aliases, ...pinned]
}

async function fetchOpenAIModels(apiKey: string): Promise<AIModelInfo[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`OpenAI API error: HTTP ${res.status}`)

  const data = await res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.data ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => {
      const id: string = m.id
      const isChat = id.startsWith('gpt-4') || id.startsWith('gpt-5')
      const isSnapshot = DATE_SUFFIX_RE.test(id) || MMDD_SUFFIX_RE.test(id)
      const isLegacy = id === 'gpt-4'
      return isChat && !isOpenAIExcluded(id) && !isSnapshot && !isLegacy
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => ({
      id: m.id as string,
      name: m.id as string,
      provider: 'openai' as const,
      isAlias: true,
    }))
    .sort((a: AIModelInfo, b: AIModelInfo) => b.id.localeCompare(a.id))
}

/**
 * GET /api/ai/models?provider=google|openai
 *
 * Retorna lista de modelos disponíveis para o provider solicitado,
 * buscando diretamente da API do provider com a chave configurada no banco.
 */
export async function GET(request: NextRequest) {
  const provider = new URL(request.url).searchParams.get('provider')

  if (provider !== 'google' && provider !== 'openai' && provider !== 'opencode_go') {
    return NextResponse.json(
      { error: 'Parâmetro "provider" inválido. Use "google", "openai" ou "opencode_go".' },
      { status: 400 }
    )
  }

  // OpenCode Go: catálogo estático (não depende de chave para listar).
  if (provider === 'opencode_go') {
    return NextResponse.json({ models: getOpenCodeGoModels() })
  }

  const keyName = provider === 'google' ? 'google_api_key' : 'openai_api_key'
  const apiKey = await getSettingValue(keyName)

  if (!apiKey) {
    return NextResponse.json({ models: [] })
  }

  try {
    const models =
      provider === 'google'
        ? await fetchGoogleModels(apiKey)
        : await fetchOpenAIModels(apiKey)

    return NextResponse.json({ models })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido'
    console.error(`[api/ai/models] ${message}`)
    return NextResponse.json(
      { error: `Falha ao buscar modelos: ${message}` },
      { status: 502 }
    )
  }
}
