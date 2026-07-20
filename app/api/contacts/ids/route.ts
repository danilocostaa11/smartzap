import { NextRequest, NextResponse } from 'next/server'
import { contactDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/contacts/ids
 * Lista IDs de contatos (com filtros opcionais)
 */
export async function GET(request: Request) {
  try {
    const auth = await requireSessionOrApiKey(request as NextRequest)
    if (auth) return auth

    const url = new URL(request.url)
    const search = url.searchParams.get('search') || ''
    const status = url.searchParams.get('status') || ''
    const tag = url.searchParams.get('tag') || ''
    const listId = url.searchParams.get('listId') || ''

    const ids = await contactDb.getIds({ search, status, tag, listId })
    return NextResponse.json(ids, {
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error) {
    console.error('Failed to fetch contact ids:', error)
    return NextResponse.json(
      { error: 'Falha ao buscar IDs de contatos' },
      { status: 500 }
    )
  }
}
