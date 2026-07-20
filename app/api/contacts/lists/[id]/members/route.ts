/**
 * POST/DELETE /api/contacts/lists/[id]/members — adicionar/remover membros
 */

import { NextRequest, NextResponse } from 'next/server'
import { contactListDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import {
  ContactListMembersSchema,
  validateBody,
  formatZodErrors,
} from '@/lib/api-validation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const { id } = await context.params
    const list = await contactListDb.getById(id)
    if (!list) {
      return NextResponse.json({ error: 'Lista não encontrada' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(ContactListMembersSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const result = await contactListDb.addMembers(id, validation.data.contactIds)
    const updated = await contactListDb.getById(id)
    return NextResponse.json({ ...result, list: updated })
  } catch (error) {
    console.error('[POST /api/contacts/lists/[id]/members]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao adicionar membros' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const { id } = await context.params
    const list = await contactListDb.getById(id)
    if (!list) {
      return NextResponse.json({ error: 'Lista não encontrada' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(ContactListMembersSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const result = await contactListDb.removeMembers(id, validation.data.contactIds)
    const updated = await contactListDb.getById(id)
    return NextResponse.json({ ...result, list: updated })
  } catch (error) {
    console.error('[DELETE /api/contacts/lists/[id]/members]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao remover membros' },
      { status: 500 }
    )
  }
}
