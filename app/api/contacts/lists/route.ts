/**
 * GET/POST /api/contacts/lists — listar e criar listas de contatos
 */

import { NextRequest, NextResponse } from 'next/server'
import { contactListDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import {
  CreateContactListSchema,
  validateBody,
  formatZodErrors,
} from '@/lib/api-validation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const lists = await contactListDb.getAllWithCounts()
    return NextResponse.json(
      { lists },
      {
        headers: {
          'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    )
  } catch (error) {
    console.error('[GET /api/contacts/lists]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao buscar listas' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(CreateContactListSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const list = await contactListDb.create(validation.data)
    return NextResponse.json(list, { status: 201 })
  } catch (error) {
    console.error('[POST /api/contacts/lists]', error)
    if (error instanceof Error && error.message.includes('duplicate')) {
      return NextResponse.json({ error: 'Já existe uma lista com este nome' }, { status: 409 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao criar lista' },
      { status: 500 }
    )
  }
}
