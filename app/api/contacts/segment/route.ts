import { NextRequest, NextResponse } from 'next/server'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import { parseCombineMode, parseSegmentList, resolveSegmentContacts } from '@/lib/contacts/segment'

export const dynamic = 'force-dynamic'
export const revalidate = 0
// Públicos grandes (dezenas de milhares de contatos) podem levar várias páginas.
export const maxDuration = 60

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

/**
 * GET /api/contacts/segment
 *
 * Resolve, no servidor, a lista COMPLETA de contatos de um segmento
 * (tags / país / UF / combine). Sem filtros, devolve todos os contatos.
 *
 * Usado pelo assistente de campanha para validar (pré-check) e criar a campanha
 * com o público inteiro — e não só com a primeira página do PostgREST.
 *
 * Query params (todos opcionais):
 *   - tags=a,b        tags (separadas por vírgula)
 *   - countries=BR,PT códigos ISO de país (derivado do DDI)
 *   - states=SP,RJ    UF brasileira (derivada do DDD)
 *   - combine=or|and  'or' (mais alcance, padrão) ou 'and' (mais preciso)
 *
 * Resposta: `{ data: Contact[], total: number }`
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const url = new URL(request.url)
    const filters = {
      tags: parseSegmentList(url.searchParams.get('tags')),
      countries: parseSegmentList(url.searchParams.get('countries')),
      states: parseSegmentList(url.searchParams.get('states')),
      combine: parseCombineMode(url.searchParams.get('combine')),
    }

    const contacts = await resolveSegmentContacts(filters)

    return NextResponse.json(
      {
        data: contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          status: contact.status,
          tags: contact.tags,
          custom_fields: contact.custom_fields,
        })),
        total: contacts.length,
      },
      { headers: NO_STORE_HEADERS }
    )
  } catch (error) {
    console.error('Failed to resolve contact segment:', error)
    return NextResponse.json(
      { error: 'Falha ao resolver público', details: (error as Error).message },
      { status: 500 }
    )
  }
}
