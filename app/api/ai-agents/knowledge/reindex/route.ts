/**
 * Reindex an existing knowledge file into pgvector.
 * Useful after embedding provider/quota fixes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  indexDocument,
  deleteFileEmbeddings,
  buildEmbeddingConfigFromAgent,
} from '@/lib/ai/rag-store'
import type { AIAgent, EmbeddingProvider } from '@/types'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

function getClient() {
  const client = getSupabaseAdmin()
  if (!client) {
    throw new Error('Supabase admin client not configured. Check SUPABASE_SECRET_KEY env var.')
  }
  return client
}

const EMBEDDING_API_KEY_MAP: Record<
  EmbeddingProvider,
  { settingKey: string; envVar: string; label: string }
> = {
  google: { settingKey: 'gemini_api_key', envVar: 'GEMINI_API_KEY', label: 'Google Gemini' },
  openai: { settingKey: 'openai_api_key', envVar: 'OPENAI_API_KEY', label: 'OpenAI' },
  voyage: { settingKey: 'voyage_api_key', envVar: 'VOYAGE_API_KEY', label: 'Voyage AI' },
  cohere: { settingKey: 'cohere_api_key', envVar: 'COHERE_API_KEY', label: 'Cohere' },
}

async function getEmbeddingApiKey(
  supabase: SupabaseClient,
  provider: EmbeddingProvider
): Promise<{ apiKey: string | null; providerLabel: string }> {
  const config = EMBEDDING_API_KEY_MAP[provider] || EMBEDDING_API_KEY_MAP.google

  const { data: setting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', config.settingKey)
    .maybeSingle()

  const apiKey = setting?.value || process.env[config.envVar] || null

  return { apiKey, providerLabel: config.label }
}

const reindexSchema = z.object({
  file_id: z.string().uuid('ID do arquivo inválido'),
})

export async function POST(request: NextRequest) {
  try {
    const supabase = getClient()
    const body = await request.json()
    const parsed = reindexSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { file_id } = parsed.data

    const { data: file, error: fileError } = await supabase
      .from('ai_knowledge_files')
      .select('*')
      .eq('id', file_id)
      .single()

    if (fileError || !file) {
      return NextResponse.json({ error: 'Arquivo não encontrado' }, { status: 404 })
    }

    if (!file.content || !String(file.content).trim()) {
      return NextResponse.json(
        { error: 'Arquivo sem conteúdo para reindexar' },
        { status: 400 }
      )
    }

    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('id', file.agent_id)
      .single()

    if (agentError || !agent) {
      return NextResponse.json({ error: 'Agente não encontrado' }, { status: 404 })
    }

    const embeddingProvider = (agent.embedding_provider || 'google') as EmbeddingProvider
    const { apiKey, providerLabel } = await getEmbeddingApiKey(supabase, embeddingProvider)

    if (!apiKey) {
      return NextResponse.json(
        {
          error: `API key do ${providerLabel} não configurada. Configure em Configurações > IA.`,
        },
        { status: 400 }
      )
    }

    await supabase
      .from('ai_knowledge_files')
      .update({ indexing_status: 'processing', chunks_count: 0 })
      .eq('id', file_id)

    // Remove embeddings antigos antes de recriar
    try {
      await deleteFileEmbeddings(file_id)
    } catch (err) {
      console.warn('[knowledge/reindex] delete embeddings warning:', err)
    }

    const embeddingConfig = buildEmbeddingConfigFromAgent(agent as AIAgent, apiKey)
    const result = await indexDocument({
      agentId: file.agent_id,
      fileId: file_id,
      content: file.content,
      embeddingConfig,
      metadata: {
        filename: file.name,
        mimeType: file.mime_type,
        reindexedAt: new Date().toISOString(),
      },
    })

    const indexingStatus = result.success ? 'completed' : 'failed'
    const chunksCount = result.success ? result.chunksIndexed : 0

    // Guarda erro em external_file_uri (campo legado) para a UI mostrar o motivo
    const errorNote = result.success
      ? null
      : `index_error:${(result.error || 'Falha ao indexar').slice(0, 480)}`

    await supabase
      .from('ai_knowledge_files')
      .update({
        indexing_status: indexingStatus,
        chunks_count: chunksCount,
        external_file_uri: errorNote,
      })
      .eq('id', file_id)

    const { data: updatedFile } = await supabase
      .from('ai_knowledge_files')
      .select('*')
      .eq('id', file_id)
      .single()

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error || 'Falha ao indexar',
          file: updatedFile || file,
          indexing_status: indexingStatus,
        },
        { status: 422 }
      )
    }

    return NextResponse.json({
      file: updatedFile || file,
      indexing_status: indexingStatus,
      chunks_indexed: chunksCount,
    })
  } catch (error) {
    console.error('[knowledge/reindex] POST Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erro interno do servidor' },
      { status: 500 }
    )
  }
}
