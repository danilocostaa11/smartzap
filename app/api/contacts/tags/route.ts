import { NextRequest, NextResponse } from 'next/server'
import { contactDb } from '@/lib/supabase-db'
import { requireSessionOrApiKey } from '@/lib/request-auth'
import {
  CreateContactTagSchema,
  RenameContactTagSchema,
  DeleteContactTagSchema,
  validateBody,
  formatZodErrors,
} from '@/lib/api-validation'
import { normalizeTagName } from '@/lib/business/contact/tags'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/contacts/tags
 * Lista tags existentes (derivadas dos contatos)
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const tags = await contactDb.getTags()
    return NextResponse.json(tags, {
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error) {
    console.error('Failed to fetch tags:', error)
    return NextResponse.json({ error: 'Falha ao buscar tags' }, { status: 500 })
  }
}

/**
 * POST /api/contacts/tags
 * Cria/aplica uma tag. Se contactIds for informado, aplica nos contatos.
 * Sem contactIds, a tag só passa a existir quando aplicada a algum contato.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(CreateContactTagSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const tag = normalizeTagName(validation.data.tag)
    const contactIds = validation.data.contactIds || []

    if (contactIds.length > 0) {
      const result = await contactDb.bulkUpdateTags(contactIds, tag, 'add')
      const tags = await contactDb.getTags()
      return NextResponse.json({ tag, ...result, tags }, { status: 201 })
    }

    // Sem contatos: retorna a tag normalizada (ficará no universo ao aplicar depois)
    const tags = await contactDb.getTags()
    const exists = tags.includes(tag)
    return NextResponse.json(
      { tag, created: !exists, applied: 0, tags: exists ? tags : [...tags, tag].sort() },
      { status: 201 }
    )
  } catch (error) {
    console.error('[POST /api/contacts/tags]', error)
    return NextResponse.json({ error: 'Falha ao criar tag' }, { status: 500 })
  }
}

/**
 * PATCH /api/contacts/tags — renomear tag globalmente
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(RenameContactTagSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const result = await contactDb.renameTagGlobal(validation.data.from, validation.data.to)
    const tags = await contactDb.getTags()
    return NextResponse.json({ ...result, tags })
  } catch (error) {
    console.error('[PATCH /api/contacts/tags]', error)
    return NextResponse.json({ error: 'Falha ao renomear tag' }, { status: 500 })
  }
}

/**
 * DELETE /api/contacts/tags — remove tag de todos os contatos
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireSessionOrApiKey(request)
    if (auth) return auth

    const body = await request.json().catch(() => ({}))
    const validation = validateBody(DeleteContactTagSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Dados inválidos', details: formatZodErrors(validation.error) },
        { status: 400 }
      )
    }

    const result = await contactDb.deleteTagGlobal(validation.data.tag)
    const tags = await contactDb.getTags()
    return NextResponse.json({ ...result, tags })
  } catch (error) {
    console.error('[DELETE /api/contacts/tags]', error)
    return NextResponse.json({ error: 'Falha ao excluir tag' }, { status: 500 })
  }
}
