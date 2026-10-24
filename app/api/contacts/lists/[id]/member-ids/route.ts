/**
 * GET /api/contacts/lists/[id]/member-ids — IDs para audiência do wizard
 */

import { NextRequest, NextResponse } from 'next/server'
import { contactListDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'

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

    const contactIds = await contactListDb.getMemberIds(id)
    return NextResponse.json(
      { listId: id, contactIds, count: contactIds.length },
      {
        headers: {
          'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    )
  } catch (error) {
    console.error('[GET /api/contacts/lists/[id]/member-ids]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha ao buscar membros' },
      { status: 500 }
    )
  }
}
