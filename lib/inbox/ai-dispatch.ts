/**
 * Publicação do job de resposta da IA (/api/ai/respond) no QStash.
 *
 * Usado por:
 * - lib/inbox/inbox-webhook.ts → agenda o job quando chega mensagem inbound
 * - app/api/ai/respond/route.ts → reagenda quando outro job já está respondendo
 *   a mesma conversa (lock ocupado)
 */

import { Client } from '@upstash/qstash'

export interface AIRespondJobBody {
  conversationId: string
  /** Debounce configurado no agente no momento do disparo */
  debounceMs?: number
  /** whatsapp_message_id da mensagem que disparou o job (dedup + "mensagem mais recente") */
  messageId?: string | null
  /** Tentativa de reagendamento (0 = disparo original do webhook) */
  attempt?: number
}

export interface DispatchAIRespondJobInput extends AIRespondJobBody {
  /** Delay em segundos (0 = imediato) */
  delaySeconds: number
}

const getQStashClient = (): Client | null => {
  const token = process.env.QSTASH_TOKEN
  if (!token) {
    console.warn('[Inbox] QSTASH_TOKEN não configurado, AI processing não disponível')
    return null
  }
  return new Client({ token })
}

export const isAIDispatchAvailable = (): boolean => !!process.env.QSTASH_TOKEN

/**
 * URL do endpoint /api/ai/respond que o QStash vai chamar.
 *
 * Prioridade: NEXT_PUBLIC_APP_URL > (preview: VERCEL_URL) > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_URL > localhost.
 *
 * Em deploys de PREVIEW da Vercel, VERCEL_PROJECT_PRODUCTION_URL continua apontando
 * para o domínio de produção; sem o ajuste abaixo, o preview agendaria jobs que seriam
 * executados pelo código de PRODUÇÃO. Produção não é afetada (VERCEL_ENV === 'production').
 */
export function resolveAIRespondUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NEXT_PUBLIC_APP_URL
  const previewUrl = env.VERCEL_ENV === 'preview' && env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null
  const productionUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null
  const vercelUrl = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null

  const baseUrl = explicit || previewUrl || productionUrl || vercelUrl || 'http://localhost:3000'
  return `${baseUrl.replace(/\/+$/, '')}/api/ai/respond`
}

/**
 * ID de deduplicação aceito pelo QStash (sem ":" e outros caracteres especiais).
 * Inclui a tentativa para que um reagendamento não seja descartado como duplicata.
 */
export function buildDeduplicationId(messageId: string, attempt: number = 0): string {
  const safe = messageId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return attempt > 0 ? `ai_respond_${safe}_a${attempt}` : `ai_respond_${safe}`
}

/**
 * Publica o job no QStash. Retorna true se foi aceito.
 */
export async function dispatchAIRespondJob(input: DispatchAIRespondJobInput): Promise<boolean> {
  const { conversationId, debounceMs, delaySeconds, messageId, attempt = 0 } = input

  const qstash = getQStashClient()
  if (!qstash) return false

  const aiRespondUrl = resolveAIRespondUrl()

  console.log(
    `🔥 [TRIGGER] Dispatching to ${aiRespondUrl} with delay=${delaySeconds}s, messageId=${messageId}, attempt=${attempt}`
  )

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // API key para passar pelo middleware de autenticação
    const apiKey = process.env.SMARTZAP_API_KEY
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    // Permite que o QStash passe pelo Deployment Protection da Vercel
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    if (bypassSecret) {
      headers['x-vercel-protection-bypass'] = bypassSecret
    }

    const body: AIRespondJobBody = { conversationId, debounceMs, messageId }
    if (attempt > 0) body.attempt = attempt

    await qstash.publishJSON({
      url: aiRespondUrl,
      body,
      delay: delaySeconds > 0 ? delaySeconds : undefined,
      retries: 2,
      headers,
      ...(messageId && { deduplicationId: buildDeduplicationId(messageId, attempt) }),
    })

    console.log(
      `✅ [TRIGGER] AI scheduled: delay=${delaySeconds}s, debounceMs=${debounceMs}, attempt=${attempt}, dedup=${messageId ? 'enabled' : 'disabled'}`
    )
    return true
  } catch (error) {
    console.error('❌ [TRIGGER] Failed to dispatch AI processing:', error)
    return false
  }
}
