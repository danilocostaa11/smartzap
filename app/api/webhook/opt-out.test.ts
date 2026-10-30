// @vitest-environment node
/**
 * Webhook inbound: "Sair" precisa aplicar o opt-out (supressão + contacts.status)
 * SEMPRE — inclusive quando a mensagem é tratada pela IA (inbox) ou quando um
 * workflow do Builder está pendente (caminho que dá `continue` no loop).
 *
 * Antes, o opt-out era o ÚLTIMO passo do loop: qualquer `continue`/erro anterior
 * pulava o registro, e mesmo quando rodava só gravava a supressão (status seguia
 * Opt-in no painel e o contador de opt-out ficava em 0).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mocks, fakeSupabase } = vi.hoisted(() => {
  /** Builder encadeável que aceita qualquer método e resolve `{ data: null, error: null }`. */
  const createNullQueryBuilder = (): any => {
    const builder: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null, count: null }).then(onFulfilled)
          }
          return () => builder
        },
      }
    )
    return builder
  }

  return {
    mocks: {
      applyInboundOptOut: vi.fn(),
      handleInboundMessage: vi.fn(),
      getPendingConversation: vi.fn(),
      workflowTrigger: vi.fn(),
    },
    fakeSupabase: { from: () => createNullQueryBuilder(), rpc: async () => ({ data: null, error: null }) },
  }
})

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => fakeSupabase,
  supabase: fakeSupabase,
}))
vi.mock('@/lib/supabase-db', () => ({
  settingsDb: { get: vi.fn().mockResolvedValue(null) },
}))
vi.mock('@/lib/contacts/opt-out', async () => {
  const actual = await vi.importActual<typeof import('@/lib/contacts/opt-out')>('@/lib/contacts/opt-out')
  return { ...actual, applyInboundOptOut: mocks.applyInboundOptOut }
})
vi.mock('@/lib/inbox/inbox-webhook', () => ({
  handleInboundMessage: mocks.handleInboundMessage,
  handleDeliveryStatus: vi.fn(),
}))
vi.mock('@/lib/builder/workflow-conversations', () => ({
  getPendingConversation: mocks.getPendingConversation,
}))
vi.mock('@/lib/builder/workflow-db', () => ({
  ensureWorkflowRecord: vi.fn(),
  getCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@upstash/workflow', () => ({
  Client: class {
    trigger = mocks.workflowTrigger
  },
}))
vi.mock('@/lib/whatsapp-credentials', () => ({
  getWhatsAppCredentials: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/verify-token', () => ({
  getVerifyToken: vi.fn().mockResolvedValue('token'),
}))
vi.mock('@/lib/whatsapp-status-events', () => ({
  applyStatusUpdateToCampaignContact: vi.fn(),
  enqueueWebhookStatusReconcileBestEffort: vi.fn(),
  markEventAttempt: vi.fn(),
  normalizeMetaStatus: (s: string) => s,
  recordStatusEvent: vi.fn(),
  tryParseWebhookTimestampSeconds: () => ({ iso: null }),
}))
vi.mock('@/lib/whatsapp-webhook-dedupe', () => ({
  shouldProcessWhatsAppStatusEvent: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/auto-suppression', () => ({
  maybeAutoSuppressByFailure: vi.fn(),
}))
vi.mock('@/lib/flow-mapping', () => ({
  applyFlowMappingToContact: vi.fn(),
}))
vi.mock('@/lib/workflow-trace', () => ({
  emitWorkflowTrace: vi.fn(),
  maskPhone: (p: string) => p,
}))

import { NextRequest } from 'next/server'
import { POST } from './route'

const FROM = '5511999990000'

const buildWebhookBody = (text: string, type: 'text' | 'button' = 'text') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '5511888880000', phone_number_id: 'pnid-1' },
            contacts: [{ profile: { name: 'Fulano' }, wa_id: FROM }],
            messages: [
              type === 'text'
                ? { from: FROM, id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: text } }
                : { from: FROM, id: 'wamid.1', timestamp: '1700000000', type: 'button', button: { text, payload: text } },
            ],
          },
        },
      ],
    },
  ],
})

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('POST /api/webhook — opt-out por palavra-chave', () => {
  beforeEach(() => {
    delete process.env.META_APP_SECRET
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.applyInboundOptOut.mockReset().mockResolvedValue({ phone: `+${FROM}`, suppressed: true, contactsUpdated: 1 })
    mocks.handleInboundMessage.mockReset().mockResolvedValue({ conversationId: 'conv-1', messageId: 'msg-1', triggeredAI: true })
    mocks.getPendingConversation.mockReset().mockResolvedValue(null)
    mocks.workflowTrigger.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  })

  it('"Sair" tratado pela IA (inbox) → aplica opt-out E mantém o fluxo da IA', async () => {
    const res = await post(buildWebhookBody('Sair'))

    expect(res.status).toBe(200)
    // Fluxo da IA preservado
    expect(mocks.handleInboundMessage).toHaveBeenCalledTimes(1)
    expect(mocks.handleInboundMessage.mock.calls[0][0]).toMatchObject({ from: FROM, text: 'Sair', type: 'text' })
    // Opt-out gravado
    expect(mocks.applyInboundOptOut).toHaveBeenCalledTimes(1)
    expect(mocks.applyInboundOptOut.mock.calls[0][0]).toMatchObject({
      phoneRaw: FROM,
      source: 'inbound_keyword',
      metadata: { text: 'Sair', messageType: 'text', messageId: 'wamid.1' },
    })
  })

  it.each(['SAIR', 'parar', 'Quero descadastrar', 'não quero mais receber'])('"%s" também aplica opt-out', async (text) => {
    await post(buildWebhookBody(text))
    expect(mocks.applyInboundOptOut).toHaveBeenCalledTimes(1)
  })

  it('botão de resposta rápida "SAIR" (type=button) aplica opt-out', async () => {
    await post(buildWebhookBody('SAIR', 'button'))
    expect(mocks.applyInboundOptOut).toHaveBeenCalledTimes(1)
    expect(mocks.applyInboundOptOut.mock.calls[0][0]).toMatchObject({ metadata: { messageType: 'button' } })
  })

  it('com workflow do Builder pendente (caminho com `continue`), o opt-out ainda é aplicado', async () => {
    mocks.getPendingConversation.mockResolvedValue({ id: 'wc-1', workflow_id: 'wf-1', phone: `+${FROM}`, status: 'waiting' })

    await post(buildWebhookBody('Sair'))

    // O resume do workflow continua acontecendo...
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/builder/workflow/wf-1/resume'), expect.anything())
    // ...e o opt-out não é pulado.
    expect(mocks.applyInboundOptOut).toHaveBeenCalledTimes(1)
  })

  it('se o inbox/IA falhar, o opt-out ainda é aplicado', async () => {
    mocks.handleInboundMessage.mockRejectedValue(new Error('inbox down'))

    const res = await post(buildWebhookBody('Sair'))

    expect(res.status).toBe(200)
    expect(mocks.applyInboundOptOut).toHaveBeenCalledTimes(1)
  })

  it('se o opt-out lançar, o webhook segue respondendo 200 (Meta exige ack)', async () => {
    mocks.applyInboundOptOut.mockRejectedValue(new Error('db down'))

    const res = await post(buildWebhookBody('Sair'))

    expect(res.status).toBe(200)
  })

  it('mensagem comum não aplica opt-out', async () => {
    await post(buildWebhookBody('Oi, quero saber o preço'))
    expect(mocks.applyInboundOptOut).not.toHaveBeenCalled()
    expect(mocks.handleInboundMessage).toHaveBeenCalledTimes(1)
  })
})
