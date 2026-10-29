import { NextRequest, NextResponse } from 'next/server'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import { countSegmentContacts, parseCombineMode, parseSegmentList } from '@/lib/contacts/segment'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/contacts/segment-count
 * Retorna contagem real de contatos com filtros por tags, pais (ISO) e UF (BR).
 *
 * - Sem filtros de localização: `count: 'exact'` direto no SQL.
 * - Com localização (país/UF derivados do telefone): pagina o banco INTEIRO e
 *   filtra em memória — sem teto de linhas (antes havia limite de 10.000).
 */
export async function GET(request: Request) {
  try {
    const auth = await requireSessionOrApiKey(request as NextRequest)
    if (auth) return auth

    const url = new URL(request.url)
    const result = await countSegmentContacts({
      tags: parseSegmentList(url.searchParams.get('tags')),
      countries: parseSegmentList(url.searchParams.get('countries')),
      states: parseSegmentList(url.searchParams.get('states')),
      combine: parseCombineMode(url.searchParams.get('combine')),
    })

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error) {
    console.error('Failed to compute segment count:', error)
    return NextResponse.json(
      { error: 'Falha ao calcular contagem', details: (error as Error).message },
      { status: 500 }
    )
  }
}
