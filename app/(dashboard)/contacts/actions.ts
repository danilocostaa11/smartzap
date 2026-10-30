'use server'

import { cache } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase'
import { collectDistinctTagsFromContacts, fetchAllRows } from '@/lib/contacts/segment'
import { PAGINATION } from '@/lib/constants'
import { ContactStatus } from '@/types'
import type { Contact, CustomFieldDefinition } from '@/types'

const PAGE_SIZE = PAGINATION.contacts

export interface ContactsInitialData {
  contacts: Contact[]
  total: number
  stats: {
    total: number
    active: number
    optOut: number
    suppressed: number
  }
  tags: string[]
  customFields: CustomFieldDefinition[]
}

// Helper para normalizar telefone (remove + se tiver)
const normalizePhone = (phone: string) => {
  const p = String(phone || '').trim()
  return p.startsWith('+') ? p.slice(1) : p
}

/**
 * Busca dados iniciais de contatos no servidor (RSC).
 * Usa cache() para deduplicação per-request.
 */
export const getContactsInitialData = cache(async (): Promise<ContactsInitialData> => {
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    throw new Error('Supabase não configurado')
  }

  // Buscar tudo em paralelo
  // Tags e stats precisam cobrir TODOS os contatos: um select sem .range() é
  // truncado pelo PostgREST em max-rows (1000 por padrão), o que escondia tags
  // novas e zerava contadores em bases maiores.
  const [contactsResult, allTags, customFieldsResult, suppressionsResult, allContactsResult] = await Promise.all([
    // Primeira página de contatos
    supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(0, PAGE_SIZE - 1),

    // Tags únicas (paginado até esgotar; mesma sanitização do RPC get_contact_tags)
    collectDistinctTagsFromContacts(),

    // Campos customizados
    supabase
      .from('custom_field_definitions')
      .select('*')
      .eq('entity_type', 'contact')
      .order('name'),

    // Supressões ativas (para calcular effectiveStatus)
    supabase
      .from('phone_suppressions')
      .select('phone,reason,source,expires_at')
      .eq('is_active', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString()),

    // Todos os telefones/status para calcular stats (paginado até esgotar)
    fetchAllRows<{ phone: string | null; status: string | null }>((pageIndex) =>
      supabase.from('contacts').select('id,phone,status', pageIndex === 0 ? { count: 'exact' } : undefined)
    ),
  ])

  // Criar mapa de supressões indexado por telefone normalizado
  const suppressionMap = new Map<string, { reason: string | null; source: string | null; expiresAt: string | null }>()
  for (const row of suppressionsResult.data || []) {
    const phone = String(row.phone || '').trim()
    if (phone) {
      const normalized = normalizePhone(phone)
      suppressionMap.set(normalized, {
        reason: row.reason ?? null,
        source: row.source ?? null,
        expiresAt: row.expires_at ?? null,
      })
    }
  }

  // Mapear contatos com effectiveStatus calculado
  const contacts: Contact[] = (contactsResult.data || []).map(c => {
    const rowPhone = String(c.phone || '').trim()
    const normalizedPhone = normalizePhone(rowPhone)
    const suppression = suppressionMap.get(normalizedPhone) || null
    const isSuppressed = suppression !== null

    // Status efetivo: SUPRIMIDO tem prioridade sobre qualquer outro status
    const dbStatus = (c.status as ContactStatus) || ContactStatus.OPT_IN
    const effectiveStatus = isSuppressed ? ContactStatus.SUPPRESSED : dbStatus

    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      status: effectiveStatus, // Status visual calculado
      originalStatus: dbStatus, // Status real do banco (para referência)
      tags: c.tags || [],
      lastActive: c.last_active || c.updated_at || c.created_at,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      custom_fields: c.custom_fields,
      suppressionReason: suppression?.reason ?? null,
      suppressionSource: suppression?.source ?? null,
      suppressionExpiresAt: suppression?.expiresAt ?? null,
    }
  })

  // Calcular stats com effectiveStatus (supressão tem prioridade)
  const allContactRows = allContactsResult.rows
  const computedStats = {
    total: allContactsResult.count ?? allContactRows.length,
    active: 0,
    optOut: 0,
    suppressed: 0
  }

  for (const row of allContactRows) {
    const phone = String(row.phone || '').trim()
    const normalizedPhone = normalizePhone(phone)
    const isSuppressed = suppressionMap.has(normalizedPhone)

    if (isSuppressed) {
      computedStats.suppressed++
    } else if (row.status === 'OPT_IN' || row.status === 'Opt-in') {
      computedStats.active++
    } else if (row.status === 'OPT_OUT' || row.status === 'Opt-out') {
      computedStats.optOut++
    }
  }

  return {
    contacts,
    total: contactsResult.count || 0,
    stats: {
      total: computedStats.total,
      active: computedStats.active,
      optOut: computedStats.optOut,
      suppressed: computedStats.suppressed
    },
    tags: allTags,
    customFields: (customFieldsResult.data || []) as CustomFieldDefinition[]
  }
})
