/**
 * Resolução de público (segmento) de contatos no servidor.
 *
 * Centraliza a lógica usada pelo assistente de campanha para:
 *   - contar quantos contatos batem com um segmento (tags / DDI / UF);
 *   - resolver a lista completa de destinatários desse segmento.
 *
 * Por que existe: o PostgREST (Supabase) limita cada resposta a `max-rows`
 * (1000 por padrão, configurável por projeto). Qualquer `select()` sem `.range()`
 * devolve só a primeira página silenciosamente, o que fazia o wizard validar e
 * enviar apenas para uma fração do público. Aqui toda leitura é paginada até
 * esgotar o banco, avançando pelo número real de linhas devolvidas (robusto a
 * qualquer `max-rows` configurado).
 */

import { parsePhoneNumber } from 'libphonenumber-js'
import { supabase } from '@/lib/supabase'
import { getBrazilUfFromPhone } from '@/lib/br-geo'
import { normalizePhoneNumber } from '@/lib/phone-formatter'

export type SegmentCombineMode = 'and' | 'or'

export interface SegmentFilters {
  tags: string[]
  countries: string[]
  states: string[]
  combine: SegmentCombineMode
}

export interface SegmentContactRow {
  id: string
  name: string
  phone: string
  email: string | null
  status: string | null
  tags: string[]
  custom_fields: Record<string, unknown>
}

/** Tamanho de página pedido ao PostgREST (o servidor pode devolver menos). */
export const SEGMENT_PAGE_SIZE = 1000

/** Colunas necessárias para o wizard (pré-check + criação de campanha). */
const CONTACT_COLUMNS = 'id,name,phone,email,status,tags,custom_fields'

/**
 * Tags que podem ser interpoladas com segurança em filtros PostgREST (`.or()`).
 * Tags fora deste padrão NÃO são descartadas: caem no filtro em memória.
 */
const SAFE_TAG_PATTERN = /^[\w\s\-áàãâéêíóôõúüçÁÀÃÂÉÊÍÓÔÕÚÜÇ]+$/i

export const isSqlSafeTag = (tag: string): boolean => SAFE_TAG_PATTERN.test(tag)

export const parseSegmentList = (value: string | null | undefined): string[] => {
  if (!value) return []
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

export const parseCombineMode = (value: string | null | undefined): SegmentCombineMode =>
  String(value || 'or').toLowerCase() === 'and' ? 'and' : 'or'

export const normalizeSegmentFilters = (input: Partial<SegmentFilters> | null | undefined): SegmentFilters => ({
  tags: Array.from(new Set((input?.tags || []).map((t) => String(t).trim()).filter(Boolean))),
  countries: Array.from(new Set((input?.countries || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))),
  states: Array.from(new Set((input?.states || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))),
  combine: input?.combine === 'and' ? 'and' : 'or',
})

const resolveCountry = (phone: string): string | null => {
  const normalized = normalizePhoneNumber(String(phone || '').trim())
  if (!normalized) return null
  try {
    const parsed = parsePhoneNumber(normalized)
    return parsed?.country || null
  } catch {
    return null
  }
}

const sanitizeTags = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
}

/** Resultado de uma página do PostgREST (subconjunto estrutural de PostgrestResponse). */
interface PageResult {
  data: unknown[] | null
  error: unknown
  count?: number | null
}

/** Builder mínimo que o paginador precisa (compatível com PostgrestFilterBuilder). */
export interface PageableQuery {
  order: (column: string, options?: { ascending?: boolean }) => {
    range: (from: number, to: number) => PromiseLike<PageResult>
  }
}

/**
 * Lê TODAS as linhas de uma query, paginando com `.range()` até esgotar.
 *
 * - Avança pelo número de linhas efetivamente devolvidas (e não pelo tamanho da
 *   página), então funciona mesmo que o `max-rows` do PostgREST seja menor que
 *   `pageSize`.
 * - Para quando uma página vem vazia ou quando já leu `count` linhas (se o
 *   servidor informou o total — normalmente pedido só na primeira página).
 *
 * @param buildQuery Monta a query base (select + filtros) para a página
 *                   `pageIndex`. É chamada a cada página porque builders do
 *                   PostgREST são mutáveis. Use `pageIndex === 0` para pedir
 *                   `count: 'exact'` só uma vez.
 */
export async function fetchAllRows<T>(
  buildQuery: (pageIndex: number) => PageableQuery,
  options: { pageSize?: number; orderBy?: string } = {}
): Promise<{ rows: T[]; count: number | null }> {
  const pageSize = Math.max(1, Math.floor(options.pageSize || SEGMENT_PAGE_SIZE))
  const orderBy = options.orderBy || 'id'
  const rows: T[] = []
  let from = 0
  let total: number | null = null

  // Guarda contra loop infinito caso o backend devolva sempre a mesma página.
  const MAX_PAGES = 100_000

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error, count } = await buildQuery(page)
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) throw error

    if (typeof count === 'number' && total === null) total = count

    const batch = (data || []) as T[]
    if (batch.length === 0) break

    rows.push(...batch)
    from += batch.length

    if (total !== null && from >= total) break
  }

  return { rows, count: total }
}

const hasLocationFilters = (filters: SegmentFilters) => filters.countries.length > 0 || filters.states.length > 0

/**
 * Decide se o filtro de tags pode ser aplicado no SQL.
 *
 * - AND: `tags @> [todas]` é sempre seguro (só reduz o dataset).
 * - OR sem localização: `or(tags @> [a], tags @> [b])` é exato.
 * - OR com localização: NÃO filtra no SQL, senão elimina contatos que batem só
 *   por país/UF. Fica em memória junto com os demais filtros.
 * - Tags com caracteres fora do padrão seguro: sempre em memória (evita
 *   injeção em `.or()` sem descartar a tag silenciosamente).
 */
export const shouldApplyTagFilterInSql = (filters: SegmentFilters): boolean => {
  if (!filters.tags.length) return false
  if (!filters.tags.every(isSqlSafeTag)) return false
  return filters.combine === 'and' || !hasLocationFilters(filters)
}

type SelectOptions = { count?: 'exact'; head?: boolean }

const buildContactsQuery = (filters: SegmentFilters, columns: string, selectOptions?: SelectOptions) => {
  let query = supabase.from('contacts').select(columns, selectOptions)

  if (shouldApplyTagFilterInSql(filters)) {
    if (filters.combine === 'and') {
      // PostgREST `cs` (contains) → `@>` no PostgreSQL
      query = query.filter('tags', 'cs', JSON.stringify(filters.tags))
    } else {
      const orConditions = filters.tags.map((tag) => `tags.cs.${JSON.stringify([tag])}`).join(',')
      query = query.or(orConditions)
    }
  }

  return query
}

/**
 * Avalia em memória se um contato pertence ao segmento.
 * `tagsAlreadyFiltered` indica que o SQL já garantiu o match de tags.
 */
export const contactMatchesSegment = (
  contact: { phone: string; tags?: unknown },
  filters: SegmentFilters,
  tagsAlreadyFiltered: boolean
): boolean => {
  const phone = String(contact.phone || '')
  const country = filters.countries.length ? resolveCountry(phone) : null
  const uf = filters.states.length ? getBrazilUfFromPhone(phone) : null

  const tagMatches: boolean[] = []
  if (!tagsAlreadyFiltered && filters.tags.length) {
    const contactTags = sanitizeTags(contact.tags)
    filters.tags.forEach((tag) => tagMatches.push(contactTags.includes(tag)))
  }
  const countryMatches = filters.countries.map((code) => Boolean(country && country === code))
  const stateMatches = filters.states.map((code) => Boolean(uf && uf === code))

  const checks = [...tagMatches, ...countryMatches, ...stateMatches]
  if (!checks.length) return true
  return filters.combine === 'or' ? checks.some(Boolean) : checks.every(Boolean)
}

/**
 * Retorna TODOS os contatos que pertencem ao segmento (sem filtros = todos os
 * contatos do banco), lendo o banco inteiro em páginas.
 */
export async function resolveSegmentContacts(input: Partial<SegmentFilters> | null | undefined): Promise<SegmentContactRow[]> {
  const filters = normalizeSegmentFilters(input)
  const tagsInSql = shouldApplyTagFilterInSql(filters)

  const { rows } = await fetchAllRows<Record<string, unknown>>(
    (pageIndex) => buildContactsQuery(filters, CONTACT_COLUMNS, pageIndex === 0 ? { count: 'exact' } : undefined)
  )

  const contacts: SegmentContactRow[] = rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    phone: String(row.phone ?? ''),
    email: (row.email as string | null | undefined) ?? null,
    status: (row.status as string | null | undefined) ?? null,
    tags: sanitizeTags(row.tags),
    custom_fields:
      row.custom_fields && typeof row.custom_fields === 'object'
        ? (row.custom_fields as Record<string, unknown>)
        : {},
  }))

  const needsInMemoryFilter = hasLocationFilters(filters) || (filters.tags.length > 0 && !tagsInSql)
  if (!needsInMemoryFilter) return contacts

  return contacts.filter((contact) => contactMatchesSegment(contact, filters, tagsInSql))
}

/**
 * Conta os contatos do segmento.
 *
 * Sem filtros de localização o `count: 'exact'` do SQL é usado (sem carregar
 * linhas). Com localização, pagina o banco inteiro e filtra em memória — não há
 * mais teto de 10.000 linhas.
 */
export async function countSegmentContacts(
  input: Partial<SegmentFilters> | null | undefined
): Promise<{ total: number; matched: number }> {
  const filters = normalizeSegmentFilters(input)
  const tagsInSql = shouldApplyTagFilterInSql(filters)
  const needsRows = hasLocationFilters(filters) || (filters.tags.length > 0 && !tagsInSql)

  if (!needsRows) {
    const { count, error } = await buildContactsQuery(filters, 'id', { count: 'exact', head: true })
    if (error) throw error
    const matched = count ?? 0
    return { total: matched, matched }
  }

  const { rows, count } = await fetchAllRows<{ phone: string; tags: unknown }>(
    (pageIndex) => buildContactsQuery(filters, 'id,phone,tags', pageIndex === 0 ? { count: 'exact' } : undefined)
  )

  const matched = rows.reduce(
    (acc, contact) => (contactMatchesSegment(contact, filters, tagsInSql) ? acc + 1 : acc),
    0
  )

  return { total: count ?? rows.length, matched }
}

/**
 * Lista todas as tags distintas de TODOS os contatos, paginando o banco.
 * Usado como fallback quando o RPC `get_contact_tags` não existe no projeto.
 */
export async function collectDistinctTagsFromContacts(): Promise<string[]> {
  const { rows } = await fetchAllRows<{ tags: unknown }>((pageIndex) =>
    supabase
      .from('contacts')
      .select('id,tags', pageIndex === 0 ? { count: 'exact' } : undefined)
      .not('tags', 'is', null)
  )

  const distinct = new Set<string>()
  for (const row of rows) {
    for (const tag of sanitizeTags(row.tags)) {
      const trimmed = tag.trim()
      // Ignora tags que parecem arrays serializados (mesma proteção do RPC)
      if (!trimmed || trimmed.startsWith('[')) continue
      distinct.add(trimmed)
    }
  }

  return Array.from(distinct).sort((a, b) => a.localeCompare(b))
}
