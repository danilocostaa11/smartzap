import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase'
import { ok, err } from '@/lib/mcp/helpers'

const baseUrl = () => process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
const apiKey = () => process.env.SMARTZAP_API_KEY ?? ''
const adminKey = () => process.env.SMARTZAP_ADMIN_KEY ?? ''

const headers = (admin = false) => ({
  'Content-Type': 'application/json',
  'x-api-key': admin ? adminKey() : apiKey(),
})

const getDb = () => getSupabaseAdmin()!

export function registerAgentsTools(server: McpServer) {
  // ─── sz.agents.list ───────────────────────────────────────────────────────
  server.registerTool(
    'sz.agents.list',
    {
      title: 'Listar agentes de IA',
      description: 'Lista todos os atendentes de IA configurados.',
      inputSchema: {},
    },
    async () => {
      const db = getDb()
      if (!db) return err('Banco não configurado')
      const { data, error } = await db
        .from('ai_agents')
        .select('id, name, model, is_active, is_default, debounce_ms, created_at')
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false })
      if (error) return err(error.message)
      return ok({ agents: data, count: data.length })
    }
  )

  // ─── sz.agents.get ────────────────────────────────────────────────────────
  server.registerTool(
    'sz.agents.get',
    {
      title: 'Detalhes do agente de IA',
      description: 'Retorna configuração completa de um agente de IA pelo ID.',
      inputSchema: {
        id: z.string().uuid().describe('UUID do agente'),
      },
    },
    async ({ id }) => {
      const db = getDb()
      if (!db) return err('Banco não configurado')
      const { data, error } = await db
        .from('ai_agents')
        .select('*')
        .eq('id', id)
        .maybeSingle()
      if (error) return err(error.message)
      if (!data) return err(`Agente ${id} não encontrado`)
      return ok(data)
    }
  )

  // ─── sz.agents.create ─────────────────────────────────────────────────────
  server.registerTool(
    'sz.agents.create',
    {
      title: 'Criar agente de IA',
      description: 'Cria um novo atendente de IA com system prompt e configurações.',
      inputSchema: {
        name: z.string().min(1).max(100).describe('Nome do agente'),
        system_prompt: z.string().min(10).describe('System prompt (instruções de comportamento)'),
        model: z.string().optional().describe('Model ID (usa o padrão configurado se omitido)'),
        temperature: z.number().min(0).max(2).optional().default(0.7),
        max_tokens: z.number().int().min(100).max(8192).optional().default(1024),
        is_active: z.boolean().optional().default(true),
        is_default: z.boolean().optional().default(false).describe('Se true, torna este o agente padrão'),
        debounce_ms: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .optional()
          .default(5000)
          .describe('Debounce antes de responder (ms). 0 = imediato'),
        handoff_enabled: z.boolean().optional().default(true),
        handoff_instructions: z.string().optional().nullable(),
        allow_reactions: z.boolean().optional().default(true),
        allow_quotes: z.boolean().optional().default(true),
      },
    },
    async (data) => {
      const res = await fetch(`${baseUrl()}/api/ai-agents`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(data),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return err(body.error ?? body.details ?? `HTTP ${res.status}`)
      return ok(body)
    }
  )

  // ─── sz.agents.update ─────────────────────────────────────────────────────
  server.registerTool(
    'sz.agents.update',
    {
      title: 'Atualizar agente de IA',
      description: 'Atualiza configuração de um agente existente. Envia apenas os campos a alterar.',
      inputSchema: {
        id: z.string().uuid().describe('UUID do agente'),
        name: z.string().min(1).max(100).optional(),
        system_prompt: z.string().min(10).optional(),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().min(100).max(8192).optional(),
        is_active: z.boolean().optional(),
        is_default: z.boolean().optional(),
        debounce_ms: z.number().int().min(0).max(30000).optional(),
        handoff_enabled: z.boolean().optional(),
        handoff_instructions: z.string().optional().nullable(),
        allow_reactions: z.boolean().optional(),
        allow_quotes: z.boolean().optional(),
        reasoning_level: z
          .enum(['minimal', 'low', 'medium', 'high'])
          .nullable()
          .optional()
          .describe('Nível de raciocínio (só Gemini 3.x). null = padrão do modelo'),
      },
    },
    async ({ id, ...data }) => {
      const res = await fetch(`${baseUrl()}/api/ai-agents/${id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(data),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return err(body.error ?? `HTTP ${res.status}`)
      return ok(body)
    }
  )

  // ─── sz.agents.delete ─────────────────────────────────────────────────────
  server.registerTool(
    'sz.agents.delete',
    {
      title: 'Remover agente de IA',
      description: 'Remove um agente de IA. Conversas ativas serão transferidas para o agente padrão.',
      inputSchema: {
        id: z.string().uuid().describe('UUID do agente'),
      },
    },
    async ({ id }) => {
      const res = await fetch(`${baseUrl()}/api/ai-agents/${id}`, {
        method: 'DELETE',
        headers: headers(true),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return err(body.error ?? `HTTP ${res.status}`)
      return ok(body)
    }
  )

  // ─── sz.agents.toggle_active ──────────────────────────────────────────────
  server.registerTool(
    'sz.agents.toggle_active',
    {
      title: 'Ativar/desativar todos os agentes',
      description: 'Liga ou desliga o sistema de resposta automática via IA para o inbox.',
      inputSchema: {
        enabled: z.boolean().describe('true = ativar, false = desativar'),
      },
    },
    async ({ enabled }) => {
      const res = await fetch(`${baseUrl()}/api/settings/ai-agents-toggle`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ enabled }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return err(body.error ?? `HTTP ${res.status}`)
      return ok(body)
    }
  )
}
