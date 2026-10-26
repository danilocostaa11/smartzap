#!/usr/bin/env node
/**
 * Simula um "burst" de mensagens inbound do WhatsApp (payload no formato da Meta)
 * contra o /api/webhook de um deploy (preview da Vercel ou localhost).
 *
 * Objetivo: validar que N mensagens rápidas do mesmo número geram UMA resposta da IA.
 *
 * Uso:
 *   node scripts/simulate-inbound-burst.mjs \
 *     --url https://<preview>.vercel.app/api/webhook \
 *     --phone 5511999999999 \
 *     --count 6 --text oi --interval 400 \
 *     [--secret "$META_APP_SECRET"]            # gera X-Hub-Signature-256 (obrigatório se o deploy tem META_APP_SECRET)
 *     [--bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"]  # passa pelo Deployment Protection do preview
 *     [--phone-number-id 123456789]            # metadata.phone_number_id do payload
 *     [--dry-run]                              # só imprime os payloads, não envia
 *
 * Também aceita as variáveis de ambiente WEBHOOK_URL, META_APP_SECRET e
 * VERCEL_AUTOMATION_BYPASS_SECRET como padrão para --url/--secret/--bypass.
 *
 * ATENÇÃO: isso grava conversa/mensagens no banco apontado pelo deploy alvo e,
 * se o número for real e o agente estiver ativo, o deploy VAI responder via WhatsApp.
 * Use um número de teste.
 */

import { createHmac, randomBytes } from 'node:crypto'

function parseArgs(argv) {
  const args = { count: 6, text: 'oi', interval: 400, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--url': args.url = next(); break
      case '--phone': args.phone = next(); break
      case '--count': args.count = Number(next()); break
      case '--text': args.text = next(); break
      case '--interval': args.interval = Number(next()); break
      case '--secret': args.secret = next(); break
      case '--bypass': args.bypass = next(); break
      case '--phone-number-id': args.phoneNumberId = next(); break
      case '--dry-run': args.dryRun = true; break
      case '--help':
      case '-h':
        console.log(readUsage())
        process.exit(0)
        break
      default:
        console.error(`Argumento desconhecido: ${arg}`)
        process.exit(2)
    }
  }
  args.url ||= process.env.WEBHOOK_URL
  args.secret ||= process.env.META_APP_SECRET
  args.bypass ||= process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  args.phoneNumberId ||= process.env.WHATSAPP_PHONE_ID || '000000000000000'
  return args
}

function readUsage() {
  return `Uso: node scripts/simulate-inbound-burst.mjs --url <https://.../api/webhook> --phone <55DDDNUMERO> [--count 6] [--text oi] [--interval 400] [--secret META_APP_SECRET] [--bypass VERCEL_AUTOMATION_BYPASS_SECRET] [--phone-number-id ID] [--dry-run]`
}

function buildPayload({ phone, text, phoneNumberId, index }) {
  const messageId = `wamid.SIM${Date.now()}${randomBytes(6).toString('hex')}_${index}`
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SIMULATED_WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: phoneNumberId, phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Teste Burst' }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

function sign(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.url || !args.phone) {
    console.error(readUsage())
    process.exit(2)
  }

  console.log(`→ Alvo: ${args.url}`)
  console.log(`→ ${args.count}x "${args.text}" de ${args.phone} a cada ${args.interval}ms`)
  console.log(`→ Assinatura: ${args.secret ? 'sim (X-Hub-Signature-256)' : 'não (deploy sem META_APP_SECRET)'}`)
  console.log(`→ Bypass Vercel: ${args.bypass ? 'sim' : 'não'}`)

  const results = []
  for (let i = 1; i <= args.count; i++) {
    const payload = buildPayload({ phone: args.phone, text: args.text, phoneNumberId: args.phoneNumberId, index: i })
    const rawBody = JSON.stringify(payload)
    const headers = { 'Content-Type': 'application/json' }
    if (args.secret) headers['X-Hub-Signature-256'] = sign(rawBody, args.secret)
    if (args.bypass) {
      headers['x-vercel-protection-bypass'] = args.bypass
      headers['x-vercel-set-bypass-cookie'] = 'true'
    }

    if (args.dryRun) {
      console.log(`[${i}] (dry-run) ${rawBody}`)
    } else {
      const startedAt = Date.now()
      try {
        const res = await fetch(args.url, { method: 'POST', headers, body: rawBody })
        const text = await res.text()
        results.push({ i, status: res.status, ms: Date.now() - startedAt })
        console.log(`[${i}] HTTP ${res.status} em ${Date.now() - startedAt}ms → ${text.slice(0, 200)}`)
      } catch (error) {
        results.push({ i, status: 'ERR', ms: Date.now() - startedAt })
        console.error(`[${i}] falhou:`, error instanceof Error ? error.message : error)
      }
    }

    if (i < args.count) await new Promise((r) => setTimeout(r, args.interval))
  }

  if (!args.dryRun) {
    const ok = results.filter((r) => r.status === 200).length
    console.log(`\n✔ ${ok}/${args.count} webhooks aceitos.`)
    console.log('Agora confira no Inbox (ou em inbox_messages) que a conversa recebeu UMA resposta da IA,')
    console.log('e nos logs da função /api/ai/respond: 1x "lock acquired" + (N-1)x "superseded"/"user-still-typing".')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
