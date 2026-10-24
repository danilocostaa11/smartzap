/**
 * Import website content into an AI agent knowledge base.
 * Crawls same-host pages (max 15) then indexes via pgvector RAG.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  crawlSite,
  mergeCrawledPages,
  normalizeSeedUrl,
} from '@/lib/ai/site-crawler'
import {
  indexDocument,
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
  google: { settingKey: 'google_api_key', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY', label: 'Google Gemini' },
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

function sanitizeContent(content: string): string {
  // eslint-disable-next-line no-control-regex
  return content.replace(/\u0000/g, '')
}

const fromUrlSchema = z.object({
  agent_id: z.string().uuid('ID do agente inválido'),
  url: z.string().min(1, 'URL é obrigatória').max(2048),
})

export async function POST(request: NextRequest) {
  try {
    const supabase = getClient()
    const body = await request.json()

    const parsed = fromUrlSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { agent_id, url } = parsed.data

    // Validate URL early (before crawl)
    try {
      normalizeSeedUrl(url)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'URL inválida' },
        { status: 400 }
      )
    }

    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('id', agent_id)
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

    console.log(`[knowledge/from-url] Crawling ${url} for agent ${agent_id}`)
    const crawl = await crawlSite(url)

    if (crawl.pages.length === 0) {
      return NextResponse.json(
        {
          error:
            'Não foi possível extrair conteúdo do site. Verifique a URL ou se o site bloqueia bots.',
          crawl_errors: crawl.errors.slice(0, 10),
        },
        { status: 422 }
      )
    }

    const merged = sanitizeContent(mergeCrawledPages(crawl))
    const name = `site:${crawl.hostname}`
    const mime_type = 'text/markdown'

    const { data: file, error: insertError } = await supabase
      .from('ai_knowledge_files')
      .insert({
        agent_id,
        name,
        mime_type,
        size_bytes: new TextEncoder().encode(merged).length,
        content: merged,
        indexing_status: 'processing',
        chunks_count: 0,
      })
      .select()
      .single()

    if (insertError || !file) {
      console.error('[knowledge/from-url] Error creating file:', insertError)
      return NextResponse.json({ error: 'Erro ao criar arquivo' }, { status: 500 })
    }

    let indexingStatus: 'completed' | 'failed' = 'failed'
    let chunksCount = 0
    let indexErrorMessage: string | null = null

    try {
      const embeddingConfig = buildEmbeddingConfigFromAgent(agent as AIAgent, apiKey)
      const result = await indexDocument({
        agentId: agent_id,
        fileId: file.id,
        content: merged,
        embeddingConfig,
        metadata: {
          filename: name,
          mimeType: mime_type,
          sourceUrl: crawl.seedUrl,
          pagesIndexed: crawl.pages.length,
        },
      })

      if (result.success) {
        indexingStatus = 'completed'
        chunksCount = result.chunksIndexed
        console.log(
          `[knowledge/from-url] Indexed ${chunksCount} chunks from ${crawl.pages.length} pages`
        )
      } else {
        indexErrorMessage = result.error || 'Falha ao indexar'
        console.error(`[knowledge/from-url] Indexing failed: ${indexErrorMessage}`)
      }
    } catch (indexError) {
      indexErrorMessage =
        indexError instanceof Error ? indexError.message : 'Erro ao indexar'
      console.error('[knowledge/from-url] Indexing error:', indexError)
    }

    await supabase
      .from('ai_knowledge_files')
      .update({
        indexing_status: indexingStatus,
        chunks_count: chunksCount,
        external_file_uri: indexErrorMessage
          ? `index_error:${indexErrorMessage.slice(0, 480)}`
          : null,
      })
      .eq('id', file.id)

    const { data: updatedFile } = await supabase
      .from('ai_knowledge_files')
      .select('*')
      .eq('id', file.id)
      .single()

    return NextResponse.json(
      {
        file: updatedFile || file,
        indexing_status: indexingStatus,
        chunks_indexed: chunksCount,
        pages_crawled: crawl.pages.length,
        crawl_errors: crawl.errors.slice(0, 10),
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('[knowledge/from-url] POST Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erro interno do servidor' },
      { status: 500 }
    )
  }
}
