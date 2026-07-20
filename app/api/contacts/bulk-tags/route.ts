/**
 * POST /api/contacts/bulk-tags
 * Adiciona ou remove uma tag em múltiplos contatos.
 */

import { NextRequest, NextResponse } from 'next/server'
import { contactDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import {
  BulkContactTagsSchema,
  formatZodErrors,
  validateBody,
} from '@/lib/api-validation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  try {
    const auth = await requireSessionOrApiKey(request as NextRequest)
    if (auth) return auth

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(BulkContactTagsSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const { contactIds, tag, action } = validation.data
    const result = await contactDb.bulkUpdateTags(contactIds, tag, action)
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error) {
    console.error('Failed to bulk update tags:', error)
    return NextResponse.json(
      { error: 'Falha ao atualizar tags em massa', details: (error as Error).message },
      { status: 500 }
    )
  }
}
