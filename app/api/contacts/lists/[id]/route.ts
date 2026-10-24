/**
 * GET/PATCH/DELETE /api/contacts/lists/[id]
 */

import { NextRequest, NextResponse } from 'next/server'
import { contactListDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import {
  UpdateContactListSchema,
  validateBody,
  formatZodErrors,
} from '@/lib/api-validation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const { id } = await context.params
    const list = await contactListDb.getById(id)
    if (!list) {
      return NextResponse.json({ error: 'Lista não encontrada' }, { status: 404 })
    }

    return NextResponse.json(list, {
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error) {
    console.error('[GET /api/contacts/lists/[id]]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao buscar lista' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const { id } = await context.params
    const body = await request.json().catch(() => ({}))
    const validation = validateBody(UpdateContactListSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const list = await contactListDb.update(id, validation.data)
    if (!list) {
      return NextResponse.json({ error: 'Lista não encontrada' }, { status: 404 })
    }

    return NextResponse.json(list)
  } catch (error) {
    console.error('[PATCH /api/contacts/lists/[id]]', error)
    if (error instanceof Error && error.message.includes('duplicate')) {
      return NextResponse.json({ error: 'Já existe uma lista com este nome' }, { status: 409 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao atualizar lista' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const { id } = await context.params
    await contactListDb.delete(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[DELETE /api/contacts/lists/[id]]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao excluir lista' },
      { status: 500 }
    )
  }
}
