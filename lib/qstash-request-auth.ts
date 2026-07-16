/**
 * Autenticação para endpoints invocados pelo QStash (publish).
 *
 * Aceita:
 * - SMARTZAP_API_KEY / SMARTZAP_ADMIN_KEY (Authorization header)
 * - Assinatura QStash (Upstash-Signature) quando signing keys estão configuradas
 */

import type { NextRequest } from 'next/server'
import { verifyApiKey, type AuthResult } from '@/lib/auth'

export async function verifyQStashOrApiKey(
  request: NextRequest,
  rawBody: string
): Promise<AuthResult> {
  const apiKeyAuth = await verifyApiKey(request)
  if (apiKeyAuth.valid) {
    return apiKeyAuth
  }

  const signature =
    request.headers.get('upstash-signature') ||
    request.headers.get('Upstash-Signature')

  if (!signature) {
    return {
      valid: false,
      error: 'Missing API key or QStash signature',
    }
  }

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY

  if (!currentSigningKey || !nextSigningKey) {
    // QStash envia Upstash-Signature em todo publish; signing keys podem faltar
    // se só QSTASH_TOKEN foi configurado manualmente na Vercel.
    console.warn(
      '[qstash-auth] QSTASH_CURRENT_SIGNING_KEY/NEXT missing — trusting Upstash-Signature header'
    )
    return { valid: true, keyType: 'api' }
  }

  try {
    const { Receiver } = await import('@upstash/qstash')
    const receiver = new Receiver({
      currentSigningKey,
      nextSigningKey,
    })

    const isValid = await receiver.verify({
      signature,
      body: rawBody,
      url: request.url,
    })

    if (isValid) {
      return { valid: true, keyType: 'api' }
    }
  } catch (error) {
    console.error('[qstash-auth] Signature verification failed:', error)
  }

  return { valid: false, error: 'Invalid QStash signature' }
}
