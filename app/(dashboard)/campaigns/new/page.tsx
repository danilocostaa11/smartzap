'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Braces, Calendar as CalendarIcon, Eye, FolderIcon, Layers, MessageSquare, Plus, RefreshCw, Save, Sparkles, Users, Wand2 } from 'lucide-react'
import { CustomFieldsSheet } from '@/components/features/contacts/CustomFieldsSheet'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { TemplatePreviewCard } from '@/components/ui/TemplatePreviewCard'
import type { Template, TemplateButton, TemplateComponent } from '@/types'
import { buildTemplateSpecV1, resolveVarValue } from '@/lib/whatsapp/template-contract'
import { replaceTemplatePlaceholders } from '@/lib/whatsapp/placeholder'
import { ContactQuickEditModal } from '@/components/features/contacts/ContactQuickEditModal'
import { campaignService } from '@/services/campaignService'
import type { CampaignPrecheckResult } from '@/services/campaignService'
import { getBrazilUfFromPhone } from '@/lib/br-geo'
import { normalizePhoneNumber } from '@/lib/phone-formatter'
import { parsePhoneNumber } from 'libphonenumber-js'
import { humanizePrecheckReason, humanizeVarSource, type ContactFixFocus, type ContactFixTarget } from '@/lib/precheck-humanizer'
import { Calendar } from '@/components/ui/calendar'
import DateTimePicker from '@/components/ui/date-time-picker'
import { cn } from '@/lib/utils'
import { ptBRLight as ptBR } from '@/lib/locale-pt-br-light'
import { getPricingBreakdown } from '@/lib/whatsapp-pricing'
import { useExchangeRate } from '@/hooks/useExchangeRate'
import { useCampaignFolders } from '@/hooks/useCampaignFolders'

const steps = [
  { id: 1, label: 'Configuração' },
  { id: 2, label: 'Público' },
  { id: 3, label: 'Validação' },
  { id: 4, label: 'Agendamento' },
]

const getDefaultScheduleTime = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 60)
  const minutes = d.getMinutes()
  if (minutes <= 30) {
    d.setMinutes(30, 0, 0)
  } else {
    d.setHours(d.getHours() + 1)
    d.setMinutes(0, 0, 0)
  }
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

const formatDateLabel = (value: string) => {
  if (!value) return 'dd/mm/aaaa'
  const [y, m, d] = value.split('-')
  if (!y || !m || !d) return 'dd/mm/aaaa'
  return `${d}/${m}/${y}`
}

const parsePickerDate = (value: string) => {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map((v) => Number(v))
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d, 12, 0, 0)
}

const buildScheduledAt = (date: string, time: string) => {
  if (!date || !time) return undefined
  const [year, month, day] = date.split('-').map((v) => Number(v))
  const [hour, minute] = time.split(':').map((v) => Number(v))
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return undefined
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

type Contact = {
  id: string
  name: string
  phone: string
  email?: string | null
  tags?: string[]
  custom_fields?: Record<string, unknown>
}

type CustomField = {
  key: string
  label: string
  type: string
}

type ContactStats = {
  total: number
  optIn: number
  optOut: number
}

type CountryCount = {
  code: string
  count: number
}

type StateCount = {
  code: string
  count: number
}

type TestContact = {
  name?: string
  phone?: string
}

type TemplateVar = {
  key: string
  placeholder: string
  value: string
  required: boolean
}

/**
 * Extrai informações do Flow de um template, se houver um botão do tipo FLOW
 */
const extractFlowFromTemplate = (template: Template | null): { flowId: string | null; flowName: string | null } => {
  if (!template?.components) return { flowId: null, flowName: null }

  for (const component of template.components) {
    if (component.type === 'BUTTONS' && component.buttons) {
      for (const button of component.buttons) {
        if (button.type === 'FLOW' && button.flow_id) {
          return {
            flowId: button.flow_id,
            flowName: button.text || null, // Nome do botão como fallback
          }
        }
      }
    }
  }

  return { flowId: null, flowName: null }
}

const fetchJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const message = await res.text()
    throw new Error(message || 'Erro ao buscar dados')
  }
  return res.json()
}

export default function CampaignsNewRealPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preselectedTemplateName = searchParams?.get('templateName') || null
  const [step, setStep] = useState(1)
  const [audienceMode, setAudienceMode] = useState('todos')
  const [combineMode, setCombineMode] = useState('or')
  const [collapseAudienceChoice, setCollapseAudienceChoice] = useState(false)
  const [collapseQuickSegments, setCollapseQuickSegments] = useState(false)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selectedCountries, setSelectedCountries] = useState<string[]>([])
  const [selectedStates, setSelectedStates] = useState<string[]>([])
  const [testContactSearch, setTestContactSearch] = useState('')
  const [selectedTestContact, setSelectedTestContact] = useState<Contact | null>(null)
  const [configuredContact, setConfiguredContact] = useState<Contact | null>(null)
  const [sendToConfigured, setSendToConfigured] = useState(true)
  const [sendToSelected, setSendToSelected] = useState(false)
  const [templateSelected, setTemplateSelected] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null)
  const [showAllTemplates, setShowAllTemplates] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('Todos')
  const [scheduleMode, setScheduleMode] = useState('imediato')
  const [isFieldsSheetOpen, setIsFieldsSheetOpen] = useState(false)
  const [scheduleDate, setScheduleDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [scheduleTime, setScheduleTime] = useState(() => getDefaultScheduleTime())
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const userTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)
  const [templateVars, setTemplateVars] = useState<{ header: TemplateVar[]; body: TemplateVar[] }>({
    header: [],
    body: [],
  })
  const [templateButtonVars, setTemplateButtonVars] = useState<Record<string, string>>({})
  const [templateSpecError, setTemplateSpecError] = useState<string | null>(null)
  const [isLaunching, setIsLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [isPrecheckLoading, setIsPrecheckLoading] = useState(false)
  const [skipIgnored, setSkipIgnored] = useState(false)
  const [precheckError, setPrecheckError] = useState<string | null>(null)
  const [precheckTotals, setPrecheckTotals] = useState<{ valid: number; skipped: number } | null>(null)
  const [precheckResult, setPrecheckResult] = useState<CampaignPrecheckResult | null>(null)

  // Aplicar em massa (bulk) um campo personalizado para desbloquear ignorados.
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkKey, setBulkKey] = useState<string>('')
  const [bulkValue, setBulkValue] = useState<string>('')
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkLoading, setBulkLoading] = useState(false)

  // Correção (igual ao /new): abrir modal focado para corrigir contatos ignorados.
  const [quickEditContactId, setQuickEditContactId] = useState<string | null>(null)
  const [quickEditFocus, setQuickEditFocus] = useState<ContactFixFocus>(null)
  const [quickEditTitle, setQuickEditTitle] = useState<string>('Editar contato')
  const [batchFixQueue, setBatchFixQueue] = useState<Array<{ contactId: string; focus: ContactFixFocus; title: string }>>([])
  const [batchFixIndex, setBatchFixIndex] = useState(0)
  const batchCloseReasonRef = useRef<'advance' | 'finish' | null>(null)
  const batchNextRef = useRef<{ contactId: string; focus: ContactFixFocus; title: string } | null>(null)
  const [campaignName, setCampaignName] = useState(() => {
    const now = new Date()
    const day = String(now.getDate()).padStart(2, '0')
    const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
    const month = months[now.getMonth()] || 'mes'
    return `Campanha ${day} de ${month}.`
  })
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({})
  const [showStatesPanel, setShowStatesPanel] = useState(false)
  const [stateSearch, setStateSearch] = useState('')
  const { rate: exchangeRate, hasRate } = useExchangeRate()
  const { folders, isLoading: isFoldersLoading } = useCampaignFolders()

  useEffect(() => {
    if (combineMode !== 'and') return
    setSelectedCountries((prev) => (prev.length > 1 ? [prev[prev.length - 1]] : prev))
    setSelectedStates((prev) => (prev.length > 1 ? [prev[prev.length - 1]] : prev))
  }, [combineMode])

  useEffect(() => {
    if (!selectedStates.length) return
    if (selectedCountries.includes('BR')) return
    setSelectedStates([])
  }, [selectedCountries, selectedStates])

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const local = await fetchJson<Template[]>('/api/templates?source=local').catch(() => [])
      if (Array.isArray(local) && local.length) return local
      return fetchJson<Template[]>('/api/templates')
    },
    staleTime: 30_000,
  })

  const customFieldsQuery = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => fetchJson<CustomField[]>('/api/custom-fields?entityType=contact'),
    staleTime: 60_000,
  })

  const customFieldLabelByKey = useMemo(() => {
    const fields = customFieldsQuery.data || []
    return Object.fromEntries(fields.map((f) => [f.key, f.label])) as Record<string, string>
  }, [customFieldsQuery.data])

  // Queries de audiência - só carregam a partir do Step 2 (Público)
  const tagsQuery = useQuery({
    queryKey: ['contact-tags'],
    queryFn: () => fetchJson<string[]>('/api/contacts/tags'),
    staleTime: 60_000,
    enabled: step >= 2,
  })

  const statsQuery = useQuery({
    queryKey: ['contact-stats'],
    queryFn: () => fetchJson<ContactStats>('/api/contacts/stats'),
    staleTime: 30_000,
    enabled: step >= 2,
  })

  const countriesQuery = useQuery({
    queryKey: ['contact-country-codes'],
    queryFn: () => fetchJson<{ data: CountryCount[] }>('/api/contacts/country-codes'),
    staleTime: 60_000,
    enabled: step >= 2,
  })

  const statesQuery = useQuery({
    queryKey: ['contact-state-codes'],
    queryFn: () => fetchJson<{ data: StateCount[] }>('/api/contacts/state-codes'),
    staleTime: 60_000,
    enabled: step >= 2,
  })

  const testContactQuery = useQuery({
    queryKey: ['test-contact'],
    queryFn: () => fetchJson<TestContact | null>('/api/settings/test-contact'),
    staleTime: 30_000,
  })

  const contactSearchQuery = useQuery({
    queryKey: ['contacts-search', testContactSearch],
    queryFn: async () => {
      // Importante: o backend ordena por created_at desc.
      // Usamos um limit maior e ordenamos no client (A-Z) para evitar que contatos antigos
      // (ex.: "Thais") fiquem de fora quando há muitos matches.
      const res = await fetchJson<{ data: Contact[] }>('/api/contacts?limit=25&search=' + encodeURIComponent(testContactSearch))
      return res.data || []
    },
    enabled: testContactSearch.trim().length >= 2,
    staleTime: 10_000,
  })

  const segmentCountQuery = useQuery({
    queryKey: ['segment-count', combineMode, selectedTags, selectedCountries, selectedStates],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('combine', combineMode)
      if (selectedTags.length) params.set('tags', selectedTags.join(','))
      if (selectedCountries.length) params.set('countries', selectedCountries.join(','))
      if (selectedStates.length) params.set('states', selectedStates.join(','))
      return fetchJson<{ total: number; matched: number }>(`/api/contacts/segment-count?${params.toString()}`)
    },
    enabled: audienceMode === 'segmentos',
    staleTime: 10_000,
  })

  const contactSearchResults = contactSearchQuery.data || []

  const sortedContactSearchResults = useMemo(() => {
    const normalizeForSearch = (value: string) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')

    const query = normalizeForSearch(testContactSearch)

    const getKey = (c: Contact) => {
      const name = String(c?.name || '').trim()
      const email = String(c?.email || '').trim()
      const phone = String(c?.phone || '').trim()
      // Prioriza nome; se não existir, usa email; depois telefone.
      return (name || email || phone || '').toLowerCase()
    }

    const getMatchRank = (c: Contact) => {
      if (!query) return 1

      const name = normalizeForSearch(String(c?.name || ''))
      const email = normalizeForSearch(String(c?.email || ''))
      const phone = normalizeForSearch(String(c?.phone || ''))

      const nameTokens = name.split(/[^a-z0-9]+/g).filter(Boolean)
      const emailTokens = email.split(/[^a-z0-9]+/g).filter(Boolean)
      const phoneTokens = phone.split(/[^a-z0-9]+/g).filter(Boolean)
      const tokens = [...nameTokens, ...emailTokens, ...phoneTokens]

      // 0 = começa com (melhor)
      if (tokens.some((t) => t.startsWith(query))) return 0
      // 1 = contém
      if (name.includes(query) || email.includes(query) || phone.includes(query)) return 1
      // 2 = não deveria acontecer (pois o backend já filtra), mas mantemos por segurança
      return 2
    }

    return [...contactSearchResults].sort((a, b) => {
      const ra = getMatchRank(a)
      const rb = getMatchRank(b)
      if (ra !== rb) return ra - rb

      const ka = getKey(a)
      const kb = getKey(b)
      const byName = ka.localeCompare(kb, 'pt-BR', { sensitivity: 'base' })
      if (byName !== 0) return byName
      // Garantir estabilidade quando chaves são iguais
      return String(a.id).localeCompare(String(b.id), 'pt-BR')
    })
  }, [contactSearchResults, testContactSearch])

  const displayTestContacts = useMemo(() => {
    if (!selectedTestContact) return sortedContactSearchResults
    const others = sortedContactSearchResults.filter((contact) => contact.id !== selectedTestContact.id)
    return [selectedTestContact, ...others]
  }, [sortedContactSearchResults, selectedTestContact])

  const configuredName = testContactQuery.data?.name?.trim() || configuredContact?.name || ''
  const configuredPhone = testContactQuery.data?.phone?.trim() || configuredContact?.phone || ''
  const hasTestPhoneInSettings = Boolean(testContactQuery.data?.phone?.trim())
  const hasConfiguredContact = Boolean(configuredContact?.phone) || hasTestPhoneInSettings
  const configuredLabel = configuredPhone
    ? [configuredName || 'Contato de teste', configuredPhone].filter(Boolean).join(' - ')
    : 'Defina um telefone de teste'

  const allTemplates = templatesQuery.data || []
  const approvedTemplates = allTemplates.filter(
    (template) => String(template.status || '').toUpperCase() === 'APPROVED'
  )
  const templateOptions = useMemo(() => {
    if (categoryFilter === 'Todos') return approvedTemplates
    // Categorias já vêm canonizadas em português: UTILIDADE, MARKETING, AUTENTICACAO
    const categoryMap: Record<string, string> = {
      'Utilidade': 'UTILIDADE',
      'Marketing': 'MARKETING',
      'Autenticacao': 'AUTENTICACAO',
    }
    const targetCategory = categoryMap[categoryFilter] || categoryFilter.toUpperCase()
    return approvedTemplates.filter(
      (template) => String(template.category || '').toUpperCase() === targetCategory
    )
  }, [approvedTemplates, categoryFilter])
  const customFields = customFieldsQuery.data || []
  const customFieldKeys = customFields.map((field) => field.key)
  const recentTemplates = useMemo(() => templateOptions.slice(0, 3), [templateOptions])
  const recommendedTemplates = useMemo(() => templateOptions.slice(3, 6), [templateOptions])
  const filteredTemplates = useMemo(() => {
    const term = templateSearch.trim().toLowerCase()
    if (!term) return templateOptions
    return templateOptions.filter((template) => template.name.toLowerCase().includes(term))
  }, [templateOptions, templateSearch])
  const hasTemplateSearch = templateSearch.trim().length > 0
  const showTemplateResults = showAllTemplates || hasTemplateSearch

  useEffect(() => {
    if (!selectedTemplate) return
    if (!templateOptions.some((template) => template.name === selectedTemplate.name)) {
      setSelectedTemplate(null)
      setTemplateSelected(false)
    }
  }, [selectedTemplate, templateOptions])

  // Pré-selecionar template da URL (ex: vindo de /templates com ?templateName=...)
  useEffect(() => {
    if (!preselectedTemplateName) return
    if (templateOptions.length === 0) return
    if (selectedTemplate) return // Já tem um selecionado, não sobrescrever

    const match = templateOptions.find(
      (t) => t.name.toLowerCase() === preselectedTemplateName.toLowerCase()
    )
    if (match) {
      setSelectedTemplate(match)
      setTemplateSelected(true)
    }
  }, [preselectedTemplateName, templateOptions, selectedTemplate])

  useEffect(() => {
    const phone = testContactQuery.data?.phone
    if (!phone) {
      setConfiguredContact(null)
      return
    }
    const controller = new AbortController()
    fetch('/api/contacts?limit=1&search=' + encodeURIComponent(phone), { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        const contact = payload?.data?.[0]
        if (contact) setConfiguredContact(contact)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [testContactQuery.data?.phone])

  // Busca contagens de contatos por tag - só roda quando tagsQuery tem dados (step >= 2)
  useEffect(() => {
    const tags = (tagsQuery.data || []).slice(0, 6)
    if (!tags.length) return
    let cancelled = false
    Promise.all(
      tags.map(async (tag) => {
        const res = await fetchJson<{ total: number }>('/api/contacts?limit=1&tag=' + encodeURIComponent(tag))
        return [tag, res.total ?? 0] as const
      })
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, number> = {}
      pairs.forEach(([tag, total]) => {
        next[tag] = total
      })
      setTagCounts(next)
    })
    return () => {
      cancelled = true
    }
  }, [tagsQuery.data])

  const contactFields = [
    { key: 'nome', label: 'Nome' },
    { key: 'telefone', label: 'Telefone' },
    { key: 'email', label: 'E-mail' },
  ]
  const sampleValues = useMemo(() => {
    const preferredContact = sendToSelected && selectedTestContact ? selectedTestContact : configuredContact
    const base = {
      nome: preferredContact?.name || configuredContact?.name || testContactQuery.data?.name || 'Contato',
      telefone:
        preferredContact?.phone ||
        configuredContact?.phone ||
        testContactQuery.data?.phone ||
        '+5511999990001',
      email: preferredContact?.email || 'contato@smartzap.com',
    } as Record<string, string>
    customFieldKeys.forEach((key) => {
      base[key] = base[key] || 'valor'
    })
    return base
  }, [
    configuredContact,
    customFieldKeys,
    selectedTestContact,
    sendToSelected,
    testContactQuery.data?.name,
    testContactQuery.data?.phone,
  ])

  const resolveValue = (key: string | undefined) => {
    if (!key) return ''
    return sampleValues[key] ?? key
  }

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

  const buildTemplateVariables = () => {
    if (!selectedTemplate) {
      return {
        header: templateVars.header.map((item) => item.value.trim()),
        body: templateVars.body.map((item) => item.value.trim()),
        buttons: {},
      }
    }

    try {
      const spec = buildTemplateSpecV1(selectedTemplate)
      const buttons = Object.fromEntries(
        Object.entries(templateButtonVars).map(([k, v]) => [k, String(v ?? '').trim()])
      )

      if (spec.parameterFormat === 'named') {
        // Mantém compatibilidade com os endpoints atuais (Meta API-style): arrays posicionais.
        // Para named, seguimos a ordem de requiredKeys do contrato.
        const headerOut = (spec.header?.requiredKeys || []).map((k) => {
          const item = templateVars.header.find((v) => v.key === k)
          return String(item?.value || '').trim()
        })
        const bodyOut = spec.body.requiredKeys.map((k) => {
          const item = templateVars.body.find((v) => v.key === k)
          return String(item?.value || '').trim()
        })

        return {
          header: headerOut,
          body: bodyOut,
          ...(Object.keys(buttons).length ? { buttons } : {}),
        }
      }

      const headerArr: string[] = []
      const bodyArr: string[] = []

      for (const v of templateVars.header) {
        const idx = Number(v.key)
        if (Number.isFinite(idx) && idx >= 1) headerArr[idx - 1] = v.value.trim()
      }

      for (const v of templateVars.body) {
        const idx = Number(v.key)
        if (Number.isFinite(idx) && idx >= 1) bodyArr[idx - 1] = v.value.trim()
      }

      const maxHeader = Math.max(0, ...(spec.header?.requiredKeys || []).map((k) => Number(k)).filter(Number.isFinite))
      const maxBody = Math.max(0, ...spec.body.requiredKeys.map((k) => Number(k)).filter(Number.isFinite))

      const headerOut = Array.from({ length: maxHeader }, (_, i) => headerArr[i] ?? '')
      const bodyOut = Array.from({ length: maxBody }, (_, i) => bodyArr[i] ?? '')

      return {
        header: headerOut,
        body: bodyOut,
        ...(Object.keys(buttons).length ? { buttons } : {}),
      }
    } catch {
      return {
        header: templateVars.header.map((item) => item.value.trim()),
        body: templateVars.body.map((item) => item.value.trim()),
        ...(Object.keys(templateButtonVars).length ? { buttons: templateButtonVars } : {}),
      }
    }
  }

  const resolveAudienceContacts = async (): Promise<Contact[]> => {
    if (audienceMode === 'teste') {
      const baseList: Contact[] = []
      if (sendToConfigured) {
        // Usa o contato real se existir
        let testContact = configuredContact

        // Se não existe no banco mas tem dados nas settings, cria o contato
        if (!testContact && testContactQuery.data?.phone) {
          try {
            const res = await fetch('/api/contacts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phone: testContactQuery.data.phone,
                name: testContactQuery.data.name || 'Contato de Teste',
                status: 'Opt-in',
              }),
            })
            if (res.ok) {
              const created = await res.json() as Contact
              testContact = created
              setConfiguredContact(created)
            } else {
              throw new Error('Falha ao criar contato')
            }
          } catch (err) {
            console.error('Erro ao criar contato de teste:', err)
            // Fallback: tenta buscar caso já exista (race condition)
            try {
              const existing = await fetchJson<{ data: Contact[] }>(
                `/api/contacts?limit=1&search=${encodeURIComponent(testContactQuery.data.phone)}`
              )
              if (existing?.data?.[0]) {
                testContact = existing.data[0]
                setConfiguredContact(testContact)
              }
            } catch {
              // Se ainda falhar, não adiciona o contato
            }
          }
        }

        if (testContact) baseList.push(testContact)
      }
      if (sendToSelected && selectedTestContact) baseList.push(selectedTestContact)

      // Importantíssimo: após "Corrigir" (PATCH) ou "Aplicar em massa", o estado local pode ficar stale
      // (selectedTestContact/configuredContact não são geridos pelo cache do React Query).
      // Aqui, por ser no máximo 2 contatos, buscamos do servidor para garantir custom_fields atualizados.
      const uniq = Array.from(new Map(baseList.map((c) => [c.id, c])).values())

      const refreshed = await Promise.all(
        uniq.map(async (c) => {
          try {
            const latest = await fetchJson<Contact>(`/api/contacts/${encodeURIComponent(c.id)}`)
            return latest || c
          } catch {
            return c
          }
        })
      )

      return refreshed
    }

    const contacts = await fetchJson<Contact[]>('/api/contacts')
    if (audienceMode === 'todos') return contacts

    if (!selectedTags.length && !selectedCountries.length && !selectedStates.length) {
      return contacts
    }

    return contacts.filter((contact) => {
      const contactTags = Array.isArray(contact.tags) ? contact.tags : []
      const phone = String(contact.phone || '')
      const country = selectedCountries.length ? resolveCountry(phone) : null
      const uf = selectedStates.length ? getBrazilUfFromPhone(phone) : null

      const tagMatches = selectedTags.map((tag) => contactTags.includes(tag))
      const countryMatches = selectedCountries.map((code) => Boolean(country && country === code))
      const stateMatches = selectedStates.map((code) => Boolean(uf && uf === code))
      const filters = [...tagMatches, ...countryMatches, ...stateMatches]

      if (!filters.length) return true
      const isMatch = combineMode === 'or' ? filters.some(Boolean) : filters.every(Boolean)
      return isMatch
    })
  }

  const selectedTestCount =
    Number(Boolean(sendToConfigured && hasConfiguredContact)) + Number(Boolean(sendToSelected && selectedTestContact))

  const runPrecheck = async () => {
    if (!templateSelected || !selectedTemplate?.name) return
    if (audienceMode === 'teste' && selectedTestCount === 0) return

    setIsPrecheckLoading(true)
    setPrecheckError(null)
    try {
      const contacts = await resolveAudienceContacts()
      if (!contacts.length) {
        setPrecheckTotals({ valid: 0, skipped: 0 })
        setPrecheckError('Nenhum contato encontrado para validar.')
        setPrecheckResult(null)
        return
      }

      const result = await campaignService.precheck({
        templateName: selectedTemplate.name,
        contacts: contacts.map((contact) => ({
          contactId: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email || undefined,
          custom_fields: contact.custom_fields || {},
        })),
        templateVariables: buildTemplateVariables(),
      })

      setPrecheckTotals({
        valid: result?.totals?.valid ?? 0,
        skipped: result?.totals?.skipped ?? 0,
      })

      setPrecheckResult(result)

      return result
    } catch (error) {
      setPrecheckError((error as Error)?.message || 'Falha ao validar destinatários.')
      setPrecheckTotals(null)
      setPrecheckResult(null)
      setSkipIgnored(false)
      return null
    } finally {
      setIsPrecheckLoading(false)
    }
  }

  const handleLaunch = async () => {
    if (!selectedTemplate?.name) return
    setIsLaunching(true)
    setLaunchError(null)
    try {
      const contacts = await resolveAudienceContacts()
      if (!contacts.length) {
        setLaunchError('Nenhum contato válido para envio.')
        return
      }

      // Alinha com /campaigns/new:
      // valida via pré-check no momento do envio/criação.
      // Se nenhum destinatário for válido, não cria a campanha.
      try {
        const precheck = await campaignService.precheck({
          templateName: selectedTemplate.name,
          contacts: contacts.map((contact) => ({
            contactId: contact.id,
            name: contact.name,
            phone: contact.phone,
            email: contact.email || undefined,
            custom_fields: contact.custom_fields || {},
          })),
          templateVariables: buildTemplateVariables(),
        })

        setPrecheckTotals({
          valid: precheck?.totals?.valid ?? 0,
          skipped: precheck?.totals?.skipped ?? 0,
        })

        setPrecheckResult(precheck)

        // Se houver ignorados por falta de variáveis obrigatórias, exige correção antes de lançar.
        const hasMissingRequired = Array.isArray((precheck as any)?.results)
          ? (precheck as any).results.some((r: any) => r && !r.ok && r.skipCode === 'MISSING_REQUIRED_PARAM')
          : false

        if ((precheck?.totals?.valid ?? 0) === 0) {
          setLaunchError('Nenhum destinatário válido para envio. Revise os ignorados e valide novamente.')
          return
        }

        if (hasMissingRequired && (precheck?.totals?.skipped ?? 0) > 0 && !skipIgnored) {
          setLaunchError('Existem contatos ignorados por falta de dados obrigatórios. Corrija os ignorados e valide novamente antes de lançar.')
          return
        }
      } catch (err) {
        // Mantém a UI consistente: falha de pré-check impede disparo.
        setLaunchError((err as Error)?.message || 'Falha ao validar destinatários antes do envio.')
        setPrecheckResult(null)
        return
      }

      const scheduledAt =
        scheduleMode === 'agendar' && scheduleDate && scheduleTime
          ? buildScheduledAt(scheduleDate, scheduleTime)
          : undefined

      // Extrair Flow do template (se houver botão do tipo FLOW)
      const { flowId, flowName } = extractFlowFromTemplate(selectedTemplate)

      const campaign = await campaignService.create({
        name: campaignName.trim(),
        templateName: selectedTemplate.name,
        selectedContacts: contacts.map((contact) => ({
          contactId: contact.id,
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email || null,
          custom_fields: contact.custom_fields || {},
        })),
        recipients: contacts.length,
        scheduledAt,
        templateVariables: buildTemplateVariables(),
        flowId,
        flowName,
        folderId: selectedFolderId,
      })

      router.push(`/campaigns/${campaign.id}`)
    } catch (error) {
      setLaunchError((error as Error)?.message || 'Falha ao lancar campanha.')
    } finally {
      setIsLaunching(false)
    }
  }

  // Salvar como rascunho (não dispara a campanha)
  const [isSavingDraft, setIsSavingDraft] = useState(false)

  const handleSaveDraft = async () => {
    if (!selectedTemplate?.name) return
    setIsSavingDraft(true)
    setLaunchError(null)
    try {
      const contacts = await resolveAudienceContacts()
      if (!contacts.length) {
        setLaunchError('Nenhum contato válido para salvar.')
        return
      }

      // Extrair Flow do template (se houver botão do tipo FLOW)
      const { flowId, flowName } = extractFlowFromTemplate(selectedTemplate)

      const campaign = await campaignService.create({
        name: campaignName.trim(),
        templateName: selectedTemplate.name,
        selectedContacts: contacts.map((contact) => ({
          contactId: contact.id,
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email || null,
          custom_fields: contact.custom_fields || {},
        })),
        recipients: contacts.length,
        templateVariables: buildTemplateVariables(),
        flowId,
        flowName,
        folderId: selectedFolderId,
        isDraft: true, // <-- Salva como rascunho
      })

      // Redireciona para a lista de campanhas (não para os detalhes)
      router.push('/campaigns')
    } catch (error) {
      setLaunchError((error as Error)?.message || 'Falha ao salvar rascunho.')
    } finally {
      setIsSavingDraft(false)
    }
  }

  const fixCandidates = useMemo(() => {
    const results = precheckResult?.results as any[] | undefined
    if (!results || !Array.isArray(results)) return [] as Array<{ contactId: string; focus: ContactFixFocus; title: string; subtitle: string }>

    const dedupeTargets = (targets: ContactFixTarget[]): ContactFixTarget[] => {
      const seen = new Set<string>()
      const out: ContactFixTarget[] = []
      for (const t of targets) {
        const id =
          t.type === 'email'
            ? 'email'
            : t.type === 'name'
              ? 'name'
              : `custom_field:${t.key}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push(t)
      }
      return out
    }

    const focusFromTargets = (targets: ContactFixTarget[]): ContactFixFocus => {
      const uniq = dedupeTargets(targets)
      if (uniq.length === 0) return null
      if (uniq.length === 1) return uniq[0]
      return { type: 'multi', targets: uniq }
    }

    const out: Array<{ contactId: string; focus: ContactFixFocus; title: string; subtitle: string }> = []

    for (const r of results) {
      if (!r || r.ok) continue
      if (r.skipCode !== 'MISSING_REQUIRED_PARAM') continue
      if (!r.contactId) continue

      const human = humanizePrecheckReason(String(r.reason || ''), { customFieldLabelByKey })
      const missing = Array.isArray(r.missing) ? (r.missing as any[]) : []
      const targets: ContactFixTarget[] = []
      for (const m of missing) {
        const inf = humanizeVarSource(String(m?.raw || '<vazio>'), customFieldLabelByKey)
        if (inf.focus) targets.push(inf.focus)
      }
      const focus = focusFromTargets(targets) || human.focus || null

      // Se não temos nada focável (ex.: token de telefone), não oferece correção via modal.
      if (!focus) continue

      const name = String(r.name || '').trim()
      const phone = String(r.phone || '').trim()
      const label = name || phone || 'Contato'
      const subtitle = phone && label !== phone ? `${label} • ${phone}` : label

      out.push({
        contactId: String(r.contactId),
        focus,
        title: human.title || 'Corrigir contato',
        subtitle,
      })
    }

    // Ordena para uma experiência consistente.
    return out
      .sort((a, b) => a.subtitle.localeCompare(b.subtitle, 'pt-BR'))
  }, [precheckResult, customFieldLabelByKey])

  const bulkCustomFieldTargets = useMemo(() => {
    const results = precheckResult?.results as any[] | undefined
    if (!results || !Array.isArray(results)) return {} as Record<string, string[]>

    const map: Record<string, Set<string>> = {}

    for (const r of results) {
      if (!r || r.ok) continue
      if (r.skipCode !== 'MISSING_REQUIRED_PARAM') continue
      if (!r.contactId) continue

      const missing = Array.isArray(r.missing) ? (r.missing as any[]) : []
      for (const m of missing) {
        const inf = humanizeVarSource(String(m?.raw || ''), customFieldLabelByKey)
        if (!inf.focus) continue
        if (inf.focus.type !== 'custom_field') continue
        const key = String(inf.focus.key || '').trim()
        if (!key) continue
        if (!map[key]) map[key] = new Set<string>()
        map[key].add(String(r.contactId))
      }
    }

    const out: Record<string, string[]> = {}
    for (const [k, set] of Object.entries(map)) {
      out[k] = Array.from(set)
    }
    return out
  }, [precheckResult, customFieldLabelByKey])

  const systemMissingCounts = useMemo(() => {
    const results = precheckResult?.results as any[] | undefined
    if (!results || !Array.isArray(results)) return { name: 0, email: 0 }

    const name = new Set<string>()
    const email = new Set<string>()

    for (const r of results) {
      if (!r || r.ok) continue
      if (r.skipCode !== 'MISSING_REQUIRED_PARAM') continue
      if (!r.contactId) continue

      const missing = Array.isArray(r.missing) ? (r.missing as any[]) : []
      for (const m of missing) {
        const inf = humanizeVarSource(String(m?.raw || ''), customFieldLabelByKey)
        if (!inf.focus) continue
        if (inf.focus.type === 'name') name.add(String(r.contactId))
        if (inf.focus.type === 'email') email.add(String(r.contactId))
      }
    }

    return { name: name.size, email: email.size }
  }, [precheckResult, customFieldLabelByKey])

  const bulkKeys = useMemo(() => {
    const keys = Object.keys(bulkCustomFieldTargets)
    return keys.sort((a, b) => {
      const ca = bulkCustomFieldTargets[a]?.length ?? 0
      const cb = bulkCustomFieldTargets[b]?.length ?? 0
      if (cb !== ca) return cb - ca
      return a.localeCompare(b, 'pt-BR')
    })
  }, [bulkCustomFieldTargets])

  useEffect(() => {
    if (!bulkKeys.length) return
    setBulkKey((prev) => (prev && bulkCustomFieldTargets[prev]?.length ? prev : bulkKeys[0]))
  }, [bulkCustomFieldTargets, bulkKeys])

  const applyBulkCustomField = async () => {
    const key = bulkKey.trim()
    const value = bulkValue.trim()
    const contactIds = bulkCustomFieldTargets[key] || []

    if (!key) {
      setBulkError('Selecione um campo personalizado.')
      return
    }
    if (!value) {
      setBulkError('Informe o valor para aplicar.')
      return
    }
    if (!contactIds.length) {
      setBulkError('Nenhum contato elegível para esse campo.')
      return
    }

    setBulkLoading(true)
    setBulkError(null)
    try {
      const res = await fetch('/api/contacts/bulk-custom-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds, key, value }),
      })

      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || 'Falha ao aplicar em massa.')
      }

      setBulkOpen(false)
      setBulkValue('')
      // Revalida para refletir o desbloqueio.
      setTimeout(() => {
        runPrecheck()
      }, 0)
    } catch (err) {
      setBulkError((err as Error)?.message || 'Falha ao aplicar em massa.')
    } finally {
      setBulkLoading(false)
    }
  }

  const openQuickEdit = (item: { contactId: string; focus: ContactFixFocus; title: string }) => {
    setQuickEditContactId(item.contactId)
    setQuickEditFocus(item.focus)
    setQuickEditTitle(`Corrigir • ${item.title}`)
  }

  const startBatchFix = () => {
    if (!fixCandidates.length) return
    const queue = fixCandidates.map((c) => ({ contactId: c.contactId, focus: c.focus, title: c.title }))
    setBatchFixQueue(queue)
    setBatchFixIndex(0)
    openQuickEdit(queue[0])
  }

  const handleQuickEditSaved = () => {
    // Revalida best-effort após salvar.
    setTimeout(() => {
      runPrecheck()
    }, 0)

    if (!batchFixQueue.length) return
    const nextIdx = batchFixIndex + 1
    if (nextIdx < batchFixQueue.length) {
      batchNextRef.current = batchFixQueue[nextIdx]
      batchCloseReasonRef.current = 'advance'
    } else {
      batchCloseReasonRef.current = 'finish'
    }
  }

  const handleQuickEditClose = () => {
    // Se o modal fechou após salvar, decidimos se avançamos ou finalizamos.
    if (batchCloseReasonRef.current === 'advance' && batchNextRef.current) {
      const next = batchNextRef.current
      batchNextRef.current = null
      batchCloseReasonRef.current = null
      setBatchFixIndex((prev) => Math.min(prev + 1, Math.max(0, batchFixQueue.length - 1)))
      openQuickEdit(next)
      return
    }

    // Encerrar lote (ou fechamento manual).
    batchNextRef.current = null
    batchCloseReasonRef.current = null
    setBatchFixQueue([])
    setBatchFixIndex(0)
    setQuickEditContactId(null)
    setQuickEditFocus(null)
    setQuickEditTitle('Editar contato')
  }

  useEffect(() => {
    if (step !== 3) return
    if (!templateSelected || !selectedTemplate?.name) return
    if (audienceMode === 'teste' && selectedTestCount === 0) return
    runPrecheck()
  }, [
    step,
    templateSelected,
    selectedTemplate?.name,
    audienceMode,
    selectedTestCount,
    sendToConfigured,
    sendToSelected,
    selectedTestContact?.id,
    configuredContact?.id,
    combineMode,
    selectedTags.join(','),
    selectedCountries.join(','),
    selectedStates.join(','),
    templateVars.header.map((item) => item.value).join('|'),
    templateVars.body.map((item) => item.value).join('|'),
    Object.entries(templateButtonVars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join('|'),
  ])

  const baseCount = statsQuery.data?.total ?? 0
  const segmentEstimate = segmentCountQuery.data?.matched ?? baseCount
  const audienceCount =
    audienceMode === 'todos' ? baseCount : audienceMode === 'segmentos' ? segmentEstimate : selectedTestCount
  const isSegmentCountLoading = audienceMode === 'segmentos' && segmentCountQuery.isFetching
  const formatCurrency = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`

  // Quando skipIgnored=true, usar apenas os contatos válidos do precheck
  const effectiveAudienceCount = skipIgnored && precheckTotals ? precheckTotals.valid : audienceCount
  const formattedAudienceCount = audienceMode === 'teste' ? selectedTestCount : effectiveAudienceCount
  const displayAudienceCount = isSegmentCountLoading ? 'Calculando...' : String(formattedAudienceCount)

  const hasPricing = Boolean(selectedTemplate?.category) && hasRate
  const basePricePerMessage = hasPricing
    ? getPricingBreakdown(selectedTemplate!.category, 1, 0, exchangeRate!).pricePerMessageBRLFormatted
    : 'R$ --'
  const audiencePricing = hasPricing
    ? getPricingBreakdown(selectedTemplate!.category, effectiveAudienceCount, 0, exchangeRate!)
    : null
  const audienceCostFormatted = hasPricing ? audiencePricing!.totalBRLFormatted : 'R$ --'
  const displayAudienceCost = isSegmentCountLoading ? '—' : audienceCostFormatted
  const pricePerMessageLabel = hasPricing ? `${audiencePricing!.pricePerMessageBRLFormatted}/msg` : 'R$ --/msg'
  const exchangeRateLabel = hasRate ? `USD/BRL ${exchangeRate!.toFixed(2).replace('.', ',')}` : 'Câmbio indisponível'
  // No Step 1 (Configuração), não faz sentido mostrar contagem/custo de audiência
  // porque o usuário ainda não selecionou o público
  const footerSummary =
    step === 1
      ? selectedTemplate?.name || 'Template selecionado'
      : audienceMode === 'teste'
        ? `${selectedTestCount || 0} contato${selectedTestCount === 1 ? '' : 's'} de teste`
        : isSegmentCountLoading
          ? 'Calculando estimativa...'
          : `${effectiveAudienceCount} contatos • ${audienceCostFormatted}`
  const activeTemplate = previewTemplate ?? (templateSelected ? selectedTemplate : null)

  const parameterFormat = (
    ((activeTemplate as any)?.parameter_format || activeTemplate?.parameterFormat || 'positional') as
      | 'positional'
      | 'named'
  )

  const previewContact = useMemo(
    () => ({
      contactId: configuredContact?.id || selectedTestContact?.id || 'preview',
      name: sampleValues.nome,
      phone: sampleValues.telefone,
      email: sampleValues.email,
      custom_fields:
        (sendToSelected && selectedTestContact ? selectedTestContact.custom_fields : configuredContact?.custom_fields) ||
        {},
    }),
    [configuredContact?.custom_fields, configuredContact?.id, sampleValues, selectedTestContact?.custom_fields, selectedTestContact?.id, sendToSelected]
  )

  const templateSpec = useMemo(() => {
    if (!activeTemplate) return null
    try {
      return buildTemplateSpecV1(activeTemplate)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao validar contrato do template'
      return { error: message } as any
    }
  }, [activeTemplate])

  const templateComponents = useMemo(() => {
    return (activeTemplate?.components || []) as TemplateComponent[]
  }, [activeTemplate])

  const headerExampleUrl = useMemo(() => {
    const header = templateComponents.find((c) => c.type === 'HEADER')
    if (!header) return null
    const format = header.format ? String(header.format).toUpperCase() : ''
    if (!['IMAGE', 'VIDEO', 'DOCUMENT', 'GIF'].includes(format)) return null

    let exampleObj: any = header.example
    if (typeof exampleObj === 'string') {
      try {
        exampleObj = JSON.parse(exampleObj)
      } catch {
        exampleObj = undefined
      }
    }
    const arr = exampleObj?.header_handle
    const candidate = Array.isArray(arr) ? arr.find((item: any) => typeof item === 'string' && item.trim()) : null
    if (!candidate) return null
    return /^https?:\/\//i.test(String(candidate || '').trim()) ? String(candidate).trim() : null
  }, [templateComponents])


  const flattenedButtons = useMemo(() => {
    const out: Array<{ index: number; button: TemplateButton }> = []
    let idx = 0
    for (const c of templateComponents) {
      if (c.type !== 'BUTTONS') continue
      const btns = (c.buttons || []) as TemplateButton[]
      for (const b of btns) {
        out.push({ index: idx, button: b })
        idx += 1
      }
    }
    return out
  }, [templateComponents])

  const resolvedHeader = useMemo(() => {
    if (!templateSpec || (templateSpec as any).error) return null
    const spec = templateSpec as ReturnType<typeof buildTemplateSpecV1>
    if (!spec.header?.requiredKeys?.length) {
      return spec.parameterFormat === 'named' ? ({} as Record<string, string>) : ([] as string[])
    }

    const getPreviewValue = (item: TemplateVar | undefined, key: string) => {
      const fallback = item?.placeholder || `{{${key}}}`
      const raw = item?.value?.trim() ? item.value : fallback
      // Quando não há valor preenchido, manter o placeholder no preview (evita "**" em OTP: *{{1}}* -> **)
      if (raw === fallback) return fallback
      const resolved = resolveVarValue(raw, previewContact)
      // Se for variável dinâmica ({{...}}) e não existir no contato de preview, não "apague" o token.
      // Isso evita bloquear o fluxo no passo 1 e mantém o preview informativo.
      if (!String(resolved || '').trim() && /\{\{[^}]+\}\}/.test(raw)) return raw
      return resolved
    }

    if (spec.parameterFormat === 'named') {
      const out: Record<string, string> = {}
      for (const k of spec.header.requiredKeys) {
        const item = templateVars.header.find((v) => v.key === k)
        out[k] = getPreviewValue(item, k)
      }
      return out
    }

    const arr: string[] = []
    for (const k of spec.header.requiredKeys) {
      const item = templateVars.header.find((v) => v.key === k)
      const resolved = getPreviewValue(item, k)
      const idx = Number(k)
      if (Number.isFinite(idx) && idx >= 1) arr[idx - 1] = resolved
    }
    return arr.map((v) => v ?? '')
  }, [previewContact, templateSpec, templateVars.header])

  const resolvedBody = useMemo(() => {
    if (!templateSpec || (templateSpec as any).error) return null
    const spec = templateSpec as ReturnType<typeof buildTemplateSpecV1>

    const getPreviewValue = (item: TemplateVar | undefined, key: string) => {
      const fallback = item?.placeholder || `{{${key}}}`
      const raw = item?.value?.trim() ? item.value : fallback
      if (raw === fallback) return fallback
      const resolved = resolveVarValue(raw, previewContact)
      if (!String(resolved || '').trim() && /\{\{[^}]+\}\}/.test(raw)) return raw
      return resolved
    }

    if (spec.parameterFormat === 'named') {
      const out: Record<string, string> = {}
      for (const k of spec.body.requiredKeys) {
        const item = templateVars.body.find((v) => v.key === k)
        out[k] = getPreviewValue(item, k)
      }
      return out
    }

    const arr: string[] = []
    for (const k of spec.body.requiredKeys) {
      const item = templateVars.body.find((v) => v.key === k)
      const resolved = getPreviewValue(item, k)
      const idx = Number(k)
      if (Number.isFinite(idx) && idx >= 1) arr[idx - 1] = resolved
    }
    return arr.map((v) => v ?? '')
  }, [previewContact, templateSpec, templateVars.body])

  const buttonAudit = useMemo(() => {
    if (!templateSpec || (templateSpec as any).error) return []
    const spec = templateSpec as ReturnType<typeof buildTemplateSpecV1>

    return spec.buttons.map((b) => {
      const uiButton = flattenedButtons.find((x) => x.index === b.index)?.button
      const base = {
        index: b.index,
        kind: b.kind,
        text: uiButton?.text || `Botão ${b.index + 1}`,
        type: uiButton?.type,
        isDynamic: b.kind === 'url' ? b.isDynamic : false,
        requiredKeys: b.kind === 'url' ? b.requiredKeys : [],
        url: uiButton?.url,
        phone: (uiButton as any)?.phone_number as string | undefined,
      }

      if (b.kind !== 'url' || !b.isDynamic || !base.url) return { ...base, resolvedUrl: base.url }

      const k = b.requiredKeys[0]
      const raw = templateButtonVars[`button_${b.index}_${k}`] || ''
      const resolved = resolveVarValue(raw, previewContact)
      const resolvedUrl = replaceTemplatePlaceholders({
        text: base.url,
        parameterFormat: 'positional',
        positionalValues: [resolved],
      })
      return { ...base, resolvedUrl, resolvedParam: resolved, rawParam: raw }
    })
  }, [flattenedButtons, previewContact, templateButtonVars, templateSpec])

  // Verifica se o template tem variáveis para preencher (header, body ou buttons dinâmicos)
  const hasTemplateVariables =
    templateVars.header.length > 0 ||
    templateVars.body.length > 0 ||
    buttonAudit.some((b: any) => b.kind === 'url' && b.isDynamic) ||
    !!templateSpecError

  const missingTemplateVars = useMemo(() => {
    // Importante: no passo 1, a regra é "preencher todos os campos obrigatórios".
    // NÃO validamos se a variável dinâmica existe no contato de teste aqui.
    // A validação de existência/resultado real ocorre no pré-check (etapa de público).
    const isFilled = (v: unknown) => String(v ?? '').trim().length > 0

    // Fallback: se não conseguimos montar spec, validamos pelo estado atual dos campos.
    if (!templateSpec || (templateSpec as any).error) {
      return [...templateVars.header, ...templateVars.body].filter((item) => item.required && !isFilled(item.value)).length
    }

    const spec = templateSpec as ReturnType<typeof buildTemplateSpecV1>
    let missing = 0

    for (const k of spec.header?.requiredKeys || []) {
      const item = templateVars.header.find((v) => v.key === k)
      if (!isFilled(item?.value)) missing += 1
    }

    for (const k of spec.body.requiredKeys) {
      const item = templateVars.body.find((v) => v.key === k)
      if (!isFilled(item?.value)) missing += 1
    }

    for (const b of spec.buttons) {
      if (b.kind !== 'url' || !b.isDynamic) continue
      for (const k of b.requiredKeys) {
        const raw = templateButtonVars[`button_${b.index}_${k}`]
        if (!isFilled(raw)) missing += 1
      }
    }

    return missing
  }, [previewContact, templateButtonVars, templateSpec, templateVars.body, templateVars.header])

  const isConfigComplete = Boolean(campaignName.trim()) && templateSelected && missingTemplateVars === 0
  const isAudienceComplete = audienceMode === 'teste' ? selectedTestCount > 0 : audienceCount > 0
  const precheckNeedsFix =
    Boolean(precheckTotals && precheckTotals.skipped > 0) && (fixCandidates.length > 0 || bulkKeys.length > 0)
  const isPrecheckOk =
    Boolean(precheckTotals) &&
    !precheckError &&
    !isPrecheckLoading &&
    (precheckTotals?.valid ?? 0) > 0 &&
    (!precheckNeedsFix || skipIgnored)
  const isScheduleComplete =
    scheduleMode !== 'agendar' || (scheduleDate.trim().length > 0 && scheduleTime.trim().length > 0)
  const canContinue =
    step === 1 ? isConfigComplete : step === 2 ? isAudienceComplete : step === 3 ? isPrecheckOk : isScheduleComplete
  const scheduleLabel = scheduleMode === 'agendar' ? 'Agendado' : 'Imediato'
  const scheduleSummaryLabel =
    step >= 4
      ? scheduleLabel
      : precheckNeedsFix && !skipIgnored
        ? 'Bloqueado (validação pendente)'
        : 'A definir'
  const combineModeLabel = combineMode === 'or' ? 'Mais alcance' : 'Mais preciso'
  const combineFilters = [...selectedTags, ...selectedCountries, ...selectedStates]
  const combinePreview = combineFilters.length
    ? combineFilters.join(' • ')
    : 'Nenhum filtro selecionado'
  const countryData = countriesQuery.data?.data || []
  const stateData = statesQuery.data?.data || []
  const tagChips = (tagsQuery.data || []).slice(0, 6)
  const countryChips = countryData.map((item) => item.code)
  const stateChips = stateData.map((item) => item.code)
  const countryCounts = useMemo(() => {
    const next: Record<string, number> = {}
    countryData.forEach((item) => {
      next[item.code] = item.count
    })
    return next
  }, [countryData])
  const stateCounts = useMemo(() => {
    const next: Record<string, number> = {}
    stateData.forEach((item) => {
      next[item.code] = item.count
    })
    return next
  }, [stateData])
  const isBrSelected = selectedCountries.includes('BR')
  const stateChipsToShow = stateChips.slice(0, 3)
  const hiddenStateCount = Math.max(0, stateChips.length - stateChipsToShow.length)
  const stateSearchTerm = stateSearch.trim().toLowerCase()
  const filteredStates = stateData.filter((item) =>
    stateSearchTerm ? item.code.toLowerCase().includes(stateSearchTerm) : true
  )
  const toggleSelection = (value: string, current: string[], setCurrent: (next: string[]) => void) => {
    setCurrent(current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  }

  useEffect(() => {
    if (!selectedTemplate) return
    setTemplateSpecError(null)
    setTemplateButtonVars({})

    try {
      const spec = buildTemplateSpecV1(selectedTemplate)
      const mapKeys = (keys: string[]) =>
        keys.map((key) => ({
          key,
          placeholder: `{{${key}}}`,
          value: '',
          required: true,
        }))

      const initialVars = {
        header: mapKeys(spec.header?.requiredKeys || []),
        body: mapKeys(spec.body.requiredKeys || []),
      }

      setTemplateVars(initialVars)

      // BYPASS: Busca marketing_variables para pré-preencher
      // Se o template veio de um projeto BYPASS, os valores promocionais ficam em marketing_variables
      const fetchMarketingVars = async () => {
        try {
          const response = await fetch(`/api/templates/${encodeURIComponent(selectedTemplate.name)}/marketing-variables`)
          if (!response.ok) return

          const data = await response.json()
          if (data.marketing_variables && data.strategy === 'bypass') {
            // Pré-preenche com marketing_variables
            setTemplateVars(prev => ({
              header: prev.header.map(item => ({
                ...item,
                value: data.marketing_variables[item.key] || item.value
              })),
              body: prev.body.map(item => ({
                ...item,
                value: data.marketing_variables[item.key] || item.value
              }))
            }))
          }
        } catch {
          // Silenciosamente ignora erros - marketing_variables é opcional
        }
      }

      fetchMarketingVars()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao validar contrato do template'
      setTemplateSpecError(message)
      setTemplateVars({ header: [], body: [] })
    }
  }, [selectedTemplate?.name])

  const setTemplateVarValue = (section: 'header' | 'body', index: number, value: string) => {
    setTemplateVars((prev) => {
      const next = { ...prev, [section]: [...prev[section]] }
      next[section][index] = { ...next[section][index], value }
      return next
    })
  }

  const setButtonVarValue = (buttonIndex: number, key: string, value: string) => {
    setTemplateButtonVars((prev) => ({
      ...prev,
      [`button_${buttonIndex}_${key}`]: value,
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="text-xs text-[var(--ds-text-muted)]">App / Campanhas / Novo</div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold text-[var(--ds-text-primary)]">Criar Campanha</h1>
          </div>
          <p className="text-sm text-[var(--ds-text-muted)]">
            Fluxo simplificado: uma decisao por vez, com contexto sempre visivel.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {steps.map((item) => {
              const isStepEnabled =
                item.id === 1 ||
                (item.id === 2 && isConfigComplete) ||
                (item.id === 3 && isConfigComplete && isAudienceComplete) ||
                (item.id === 4 && isConfigComplete && isAudienceComplete && isPrecheckOk)
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!isStepEnabled}
                  onClick={() => {
                    if (!isStepEnabled) return
                    setStep(item.id)
                  }}
                  title={
                    isStepEnabled
                      ? undefined
                      : item.id === 2
                        ? 'Complete a configuração para avançar'
                        : item.id === 3
                          ? 'Complete configuração e público para avançar'
                          : 'Finalize a validação para avançar'
                  }
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm transition ${
                    step === item.id
                      ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-[var(--ds-text-primary)]'
                      : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-secondary)]'
                  } ${!isStepEnabled ? 'cursor-not-allowed opacity-40' : 'hover:text-[var(--ds-text-primary)]'}`}
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 aspect-square place-items-center rounded-full border text-xs font-semibold leading-none ${
                      step === item.id
                        ? 'border-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200'
                        : 'border-[var(--ds-border-default)] text-[var(--ds-text-secondary)]'
                    }`}
                  >
                    {item.id}
                  </span>
                  <span className="text-xs uppercase tracking-widest">{item.label}</span>
                </button>
              )
            })}
          </div>
          {step === 1 && (
            <div className="space-y-6">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <input
                  className="w-full h-11 flex-1 rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-4 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)]"
                  placeholder="Nome da campanha"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  aria-label="Nome da campanha"
                />
                <div className="relative w-full lg:w-36">
                  <select
                    className="w-full h-11 appearance-none rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] pl-4 pr-10 text-sm text-[var(--ds-text-primary)]"
                    aria-label="Filtrar por categoria"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                  >
                    <option value="Todos">Todos</option>
                    <option value="Utilidade">Utilidade</option>
                    <option value="Marketing">Marketing</option>
                    <option value="Autenticacao">Autenticação</option>
                  </select>
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-lg text-emerald-700 dark:text-emerald-200">
                    ▾
                  </span>
                </div>
              </div>

              {templateSelected ? (
                <div className="flex h-11 flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-4 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-emerald-600 dark:border-emerald-400/40 text-[10px] text-emerald-700 dark:text-emerald-300">
                      ✓
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-[var(--ds-text-primary)]">{selectedTemplate?.name}</span>
                      {selectedTemplate?.category && (
                        <span className="text-[10px] uppercase tracking-widest text-[var(--ds-text-muted)]">
                          {selectedTemplate.category}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateSelected(false)
                      setPreviewTemplate(null)
                    }}
                    className="text-xs text-emerald-600 dark:text-emerald-400/80 hover:text-emerald-700 dark:text-emerald-300"
                  >
                    Trocar
                  </button>
                </div>
              ) : (
                <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_10px_26px_rgba(0,0,0,0.3)]">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Template</h2>
                    <p className="text-sm text-[var(--ds-text-muted)]">Busque e escolha o template da campanha.</p>
                  </div>

                  <div className="mt-5">
                    <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Buscar template</label>
                    <input
                      className="mt-2 w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-4 py-3 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)]"
                      placeholder="Digite o nome do template..."
                      value={templateSearch}
                      onChange={(event) => setTemplateSearch(event.target.value)}
                    />
                    {templatesQuery.isLoading && (
                      <div className="mt-2 text-xs text-[var(--ds-text-muted)]">Carregando templates...</div>
                    )}
                    {templatesQuery.isError && (
                      <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        Falha ao carregar templates. Verifique as credenciais.
                      </div>
                    )}
                    {!templatesQuery.isLoading && !templatesQuery.isError && templateOptions.length === 0 && (
                      <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">Nenhum template aprovado encontrado.</div>
                    )}
                  </div>

                  {showTemplateResults ? (
                    <div className="mt-5 rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                          {hasTemplateSearch ? 'Resultados da busca' : 'Todos os templates'}
                        </div>
                        {hasTemplateSearch ? (
                          <button
                            type="button"
                            onClick={() => setTemplateSearch('')}
                            className="text-xs text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
                          >
                            Limpar busca
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowAllTemplates(false)}
                            className="text-xs text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
                          >
                            Voltar para recentes
                          </button>
                        )}
                      </div>
                      <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-2 text-sm">
                        {filteredTemplates.length === 0 ? (
                          <div className="text-xs text-[var(--ds-text-muted)]">Nenhum template encontrado.</div>
                        ) : (
                          filteredTemplates.map((template) => (
                            <button
                              key={template.id}
                              type="button"
                              onMouseEnter={() => setPreviewTemplate(template)}
                              onMouseLeave={() => setPreviewTemplate(null)}
                              onClick={() => {
                                setSelectedTemplate(template)
                                setTemplateSelected(true)
                                setPreviewTemplate(null)
                              }}
                              className="w-full rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-left text-[var(--ds-text-secondary)] hover:border-emerald-600 dark:hover:border-emerald-400/40"
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-[var(--ds-text-primary)]">{template.name}</span>
                                <span className="text-[10px] uppercase text-[var(--ds-text-muted)]">{template.category}</span>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                          <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Recentes</div>
                          <div className="mt-3 space-y-2 text-sm">
                            {recentTemplates.map((template) => (
                              <button
                                key={template.id}
                                type="button"
                                onMouseEnter={() => setPreviewTemplate(template)}
                                onMouseLeave={() => setPreviewTemplate(null)}
                                onClick={() => {
                                  setSelectedTemplate(template)
                                  setTemplateSelected(true)
                                  setPreviewTemplate(null)
                                }}
                                className="w-full rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-left text-[var(--ds-text-secondary)] hover:border-emerald-600 dark:hover:border-emerald-400/40"
                              >
                                <div className="font-semibold text-[var(--ds-text-primary)]">{template.name}</div>
                                <div className="mt-1 text-xs text-[var(--ds-text-muted)]">{template.category}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                          <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Recomendados</div>
                          <div className="mt-3 space-y-2 text-sm">
                            {recommendedTemplates.map((template) => (
                              <button
                                key={template.id}
                                type="button"
                                onMouseEnter={() => setPreviewTemplate(template)}
                                onMouseLeave={() => setPreviewTemplate(null)}
                                onClick={() => {
                                  setSelectedTemplate(template)
                                  setTemplateSelected(true)
                                  setPreviewTemplate(null)
                                }}
                                className="w-full rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-left text-[var(--ds-text-secondary)] hover:border-emerald-600 dark:hover:border-emerald-400/40"
                              >
                                <div className="font-semibold text-[var(--ds-text-primary)]">{template.name}</div>
                                <div className="mt-1 text-xs text-[var(--ds-text-muted)]">{template.category}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      {!showTemplateResults && (
                        <button
                          type="button"
                          onClick={() => setShowAllTemplates(true)}
                          className="mt-4 text-xs text-emerald-700 dark:text-emerald-300"
                        >
                          Ver todos os templates
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {templateSelected && hasTemplateVariables && (
                <div className="rounded-2xl border border-emerald-400/30 bg-emerald-100 dark:bg-emerald-500/10 p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200">
                      <Sparkles size={18} />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Variáveis do Template</h2>
                      <p className="text-sm text-[var(--ds-text-muted)]">
                        Use texto fixo ou variável dinâmica (ícone {'{}'} → Nome). Dinâmicas mudam por destinatário; texto fixo é igual para todos.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-5">
                    {templateSpecError && (
                      <div className="rounded-xl border border-amber-400 dark:border-amber-400/30 bg-amber-100 dark:bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
                        <div className="font-semibold">Template com contrato inválido</div>
                        <div className="mt-1 text-xs text-amber-700 dark:text-amber-200/80">{templateSpecError}</div>
                      </div>
                    )}
                    {templateVars.header.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                          <Eye size={14} />
                          <span>Variáveis do cabeçalho</span>
                        </div>
                      <div className="space-y-3">
                          {templateVars.header.map((item, index) => (
                            <div key={item.key} className="flex items-center gap-3">
                              <span className="rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2 py-1 text-xs text-amber-700 dark:text-amber-200">
                                {item.placeholder}
                              </span>
                              <div className="relative flex flex-1 items-center">
                                <input
                                  value={item.value}
                                  onChange={(event) => setTemplateVarValue('header', index, event.target.value)}
                                  placeholder={`Variável do cabeçalho (${item.placeholder})`}
                                  className={`w-full rounded-xl border bg-[var(--ds-bg-elevated)] px-4 py-2 pr-10 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] ${
                                    !item.value.trim() && item.required
                                      ? 'border-amber-400 dark:border-amber-400/40'
                                      : 'border-[var(--ds-border-default)]'
                                  }`}
                                />
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-secondary)] hover:text-amber-700 dark:text-amber-300"
                                    >
                                      <Braces size={14} />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    className="min-w-52 border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-primary)]"
                                  >
                                    <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                      Dados do contato
                                    </DropdownMenuLabel>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('header', index, '{{nome}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <Users size={14} className="text-indigo-400" />
                                      <span>Nome</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('header', index, '{{telefone}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <div className="text-green-400 font-mono text-[10px] w-3.5 text-center">Ph</div>
                                      <span>Telefone</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('header', index, '{{email}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <div className="text-blue-400 font-mono text-[10px] w-3.5 text-center">@</div>
                                      <span>E-mail</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                    {customFields.length > 0 && (
                                      <>
                                        <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                          Campos personalizados
                                        </DropdownMenuLabel>
                                        {customFields.map((field) => (
                                          <DropdownMenuItem
                                            key={field.key}
                                            onSelect={() => setTemplateVarValue('header', index, `{{${field.key}}}`)}
                                            className="flex items-center gap-2"
                                          >
                                            <div className="text-amber-600 dark:text-amber-400 font-mono text-[10px] w-3.5 text-center">#</div>
                                            <span>{field.label || field.key}</span>
                                          </DropdownMenuItem>
                                        ))}
                                        <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                      </>
                                    )}
                                    <DropdownMenuItem
                                      onSelect={() => setIsFieldsSheetOpen(true)}
                                      className="text-xs text-amber-600 dark:text-amber-400"
                                    >
                                      <Plus size={12} /> Gerenciar campos
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                              {item.required && <span className="text-xs text-amber-700 dark:text-amber-300">obrigatório</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {templateVars.body.length > 0 && (
                      <div className="space-y-3 border-t border-[var(--ds-border-default)] pt-4">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                          <MessageSquare size={14} />
                          <span>Variáveis do corpo</span>
                        </div>
                        <div className="space-y-3">
                          {templateVars.body.map((item, index) => (
                            <div key={`${item.key}-${index}`} className="flex items-center gap-3">
                              <span className="rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2 py-1 text-xs text-amber-700 dark:text-amber-200">
                                {item.placeholder}
                              </span>
                              <div className="relative flex flex-1 items-center">
                                <input
                                  value={item.value}
                                  onChange={(event) => setTemplateVarValue('body', index, event.target.value)}
                                  placeholder={`Variável do corpo (${item.placeholder})`}
                                  className={`w-full rounded-xl border bg-[var(--ds-bg-elevated)] px-4 py-2 pr-10 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] ${
                                    !item.value.trim() && item.required
                                      ? 'border-amber-400 dark:border-amber-400/40'
                                      : 'border-[var(--ds-border-default)]'
                                  }`}
                                />
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-secondary)] hover:text-amber-700 dark:text-amber-300"
                                    >
                                      <Braces size={14} />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    className="min-w-52 border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-primary)]"
                                  >
                                    <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                      Dados do contato
                                    </DropdownMenuLabel>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('body', index, '{{nome}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <Users size={14} className="text-indigo-400" />
                                      <span>Nome</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('body', index, '{{telefone}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <div className="text-green-400 font-mono text-[10px] w-3.5 text-center">Ph</div>
                                      <span>Telefone</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => setTemplateVarValue('body', index, '{{email}}')}
                                      className="flex items-center gap-2"
                                    >
                                      <div className="text-blue-400 font-mono text-[10px] w-3.5 text-center">@</div>
                                      <span>E-mail</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                    {customFields.length > 0 && (
                                      <>
                                        <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                          Campos personalizados
                                        </DropdownMenuLabel>
                                        {customFields.map((field) => (
                                          <DropdownMenuItem
                                            key={field.key}
                                            onSelect={() => setTemplateVarValue('body', index, `{{${field.key}}}`)}
                                            className="flex items-center gap-2"
                                          >
                                            <div className="text-amber-600 dark:text-amber-400 font-mono text-[10px] w-3.5 text-center">#</div>
                                            <span>{field.label || field.key}</span>
                                          </DropdownMenuItem>
                                        ))}
                                        <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                      </>
                                    )}
                                    <DropdownMenuItem
                                      onSelect={() => setIsFieldsSheetOpen(true)}
                                      className="text-xs text-amber-600 dark:text-amber-400"
                                    >
                                      <Plus size={12} /> Gerenciar campos
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                              {item.required && <span className="text-xs text-amber-700 dark:text-amber-300">obrigatório</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {buttonAudit.some((b: any) => b.kind === 'url' && b.isDynamic) && (
                      <div className="space-y-3 border-t border-[var(--ds-border-default)] pt-4">
                        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                          <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-200">URL</span>
                          <span>Variáveis dos botões</span>
                        </div>

                        <div className="space-y-3">
                          {buttonAudit
                            .filter((b: any) => b.kind === 'url' && b.isDynamic)
                            .map((b: any) => (
                              <div key={`btn-${b.index}`} className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-sm font-semibold text-[var(--ds-text-primary)]">{b.text}</div>
                                  <div className="text-[10px] uppercase tracking-widest text-[var(--ds-text-muted)]">botão {b.index + 1}</div>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {(b.requiredKeys as string[]).map((k) => {
                                    const id = `{{${k}}}`
                                    const value = templateButtonVars[`button_${b.index}_${k}`] || ''
                                    return (
                                      <div key={`btn-${b.index}-${k}`} className="flex items-center gap-3">
                                        <span className="rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2 py-1 text-xs text-amber-700 dark:text-amber-200">{id}</span>
                                        <div className="relative flex flex-1 items-center">
                                          <input
                                            value={value}
                                            onChange={(event) => setButtonVarValue(b.index, k, event.target.value)}
                                            placeholder={`Variável do botão (${id})`}
                                            className={`w-full rounded-xl border bg-[var(--ds-bg-elevated)] px-4 py-2 pr-10 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] ${
                                              !value.trim() ? 'border-amber-400 dark:border-amber-400/40' : 'border-[var(--ds-border-default)]'
                                            }`}
                                          />
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <button
                                                type="button"
                                                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-secondary)] hover:text-amber-700 dark:text-amber-300"
                                              >
                                                <Braces size={14} />
                                              </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent
                                              align="end"
                                              className="min-w-52 border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-primary)]"
                                            >
                                              <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                                Dados do contato
                                              </DropdownMenuLabel>
                                              <DropdownMenuItem
                                                onSelect={() => setButtonVarValue(b.index, k, '{{nome}}')}
                                                className="flex items-center gap-2"
                                              >
                                                <Users size={14} className="text-indigo-400" />
                                                <span>Nome</span>
                                              </DropdownMenuItem>
                                              <DropdownMenuItem
                                                onSelect={() => setButtonVarValue(b.index, k, '{{telefone}}')}
                                                className="flex items-center gap-2"
                                              >
                                                <div className="text-green-400 font-mono text-[10px] w-3.5 text-center">Ph</div>
                                                <span>Telefone</span>
                                              </DropdownMenuItem>
                                              <DropdownMenuItem
                                                onSelect={() => setButtonVarValue(b.index, k, '{{email}}')}
                                                className="flex items-center gap-2"
                                              >
                                                <div className="text-blue-400 font-mono text-[10px] w-3.5 text-center">@</div>
                                                <span>E-mail</span>
                                              </DropdownMenuItem>
                                              <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                              {customFields.length > 0 && (
                                                <>
                                                  <DropdownMenuLabel className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">
                                                    Campos personalizados
                                                  </DropdownMenuLabel>
                                                  {customFields.map((field) => (
                                                    <DropdownMenuItem
                                                      key={field.key}
                                                      onSelect={() => setButtonVarValue(b.index, k, `{{${field.key}}}`)}
                                                      className="flex items-center gap-2"
                                                    >
                                                      <div className="text-amber-600 dark:text-amber-400 font-mono text-[10px] w-3.5 text-center">#</div>
                                                      <span>{field.label || field.key}</span>
                                                    </DropdownMenuItem>
                                                  ))}
                                                  <DropdownMenuSeparator className="bg-[var(--ds-bg-hover)]" />
                                                </>
                                              )}
                                              <DropdownMenuItem
                                                onSelect={() => setIsFieldsSheetOpen(true)}
                                                className="text-xs text-amber-600 dark:text-amber-400"
                                              >
                                                <Plus size={12} /> Gerenciar campos
                                              </DropdownMenuItem>
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        </div>
                                        <span className="text-xs text-amber-700 dark:text-amber-300">obrigatório</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                {collapseAudienceChoice ? (
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Público</div>
                      <div className="mt-1 text-sm font-semibold text-[var(--ds-text-primary)]">
                        {audienceMode === 'todos' && 'Todos'}
                        {audienceMode === 'segmentos' && 'Segmentos'}
                        {audienceMode === 'teste' && 'Teste'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCollapseAudienceChoice(false)}
                      className="text-xs text-emerald-700 dark:text-emerald-300"
                    >
                      Editar público
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Escolha o público</h2>
                      <p className="text-sm text-[var(--ds-text-muted)]">Uma decisao rapida antes dos filtros.</p>
                    </div>
                    <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                      {[
                        { label: 'Todos', value: 'todos', helper: `${statsQuery.data?.optIn ?? 0} contatos elegíveis` },
                        { label: 'Segmentos', value: 'segmentos', helper: 'Filtrar por tags, DDI ou UF' },
                        { label: 'Teste', value: 'teste', helper: 'Enviar para contato de teste' },
                      ].map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setAudienceMode(item.value)}
                          className={`rounded-2xl border px-4 py-4 text-left text-sm ${
                            audienceMode === item.value
                              ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-[var(--ds-text-primary)]'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                          }`}
                        >
                          <div className="text-sm font-semibold">{item.label}</div>
                          <div className="mt-2 text-xs text-[var(--ds-text-muted)]">{item.helper}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {audienceMode === 'todos' && (
                <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Todos os contatos</h2>
                    <p className="text-sm text-[var(--ds-text-muted)]">Nenhum filtro aplicado.</p>
                  </div>
                  <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                      <p className="text-2xl font-semibold text-[var(--ds-text-primary)]">{statsQuery.data?.optIn ?? 0}</p>
                      <p className="text-xs text-[var(--ds-text-muted)]">Elegíveis</p>
                    </div>
                    <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                      <p className="text-2xl font-semibold text-amber-700 dark:text-amber-200">{statsQuery.data?.optOut ?? 0}</p>
                      <p className="text-xs text-[var(--ds-text-muted)]">Suprimidos</p>
                    </div>
                    <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                      <p className="text-2xl font-semibold text-[var(--ds-text-primary)]">0</p>
                      <p className="text-xs text-[var(--ds-text-muted)]">Duplicados</p>
                    </div>
                  </div>
                  <p className="mt-4 text-xs text-[var(--ds-text-muted)]">
                    Envio para todos os contatos válidos, excluindo opt-out e suprimidos.
                  </p>
                </div>
              )}

              {audienceMode === 'segmentos' && (
                <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                  <Sheet open={showStatesPanel} onOpenChange={setShowStatesPanel}>
                    <SheetContent className="w-full border-l border-[var(--ds-border-default)] bg-[var(--ds-bg-base)] p-0 sm:max-w-md">
                      <SheetHeader className="border-b border-[var(--ds-border-default)] p-6">
                        <SheetTitle className="text-[var(--ds-text-primary)]">Selecionar UF</SheetTitle>
                        <SheetDescription className="text-[var(--ds-text-secondary)]">
                          Escolha os estados para segmentar.
                        </SheetDescription>
                      </SheetHeader>
                      <div className="space-y-4 p-6">
                        {!isBrSelected && (
                          <div className="rounded-lg border border-amber-300 dark:border-amber-400/20 bg-amber-100 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                            Selecione BR no DDI para habilitar as UFs.
                          </div>
                        )}
                        <input
                          className="w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)]"
                          placeholder="Buscar UF..."
                          value={stateSearch}
                          onChange={(event) => setStateSearch(event.target.value)}
                        />
                        <div className="max-h-64 overflow-y-auto pr-1">
                          <div className="flex flex-wrap gap-2">
                            {filteredStates.length === 0 && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Nenhuma UF encontrada.</span>
                            )}
                            {filteredStates.map((item) => {
                              const active = selectedStates.includes(item.code)
                              const disabled = !isBrSelected
                              return (
                                <button
                                  key={item.code}
                                  type="button"
                                  disabled={disabled}
                                  aria-disabled={disabled}
                                  onClick={() => {
                                    if (disabled) return
                                    if (combineMode === 'and') {
                                      setSelectedStates(active ? [] : [item.code])
                                      return
                                    }
                                    toggleSelection(item.code, selectedStates, setSelectedStates)
                                  }}
                                  className={`rounded-full border px-3 py-1 text-xs ${
                                    active
                                      ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100'
                                      : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                                  } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                                >
                                  <span>{item.code}</span>
                                  <sup className="ml-1 text-[8px] leading-none text-amber-700 dark:text-amber-300">{item.count}</sup>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    </SheetContent>
                  </Sheet>
                  {collapseQuickSegments ? (
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Segmentos rapidos</div>
                        <div className="mt-1 text-sm font-semibold text-[var(--ds-text-primary)]">Resumo aplicado</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCollapseQuickSegments(false)}
                        className="text-xs text-emerald-700 dark:text-emerald-300"
                      >
                        Editar segmentos
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Segmentos rapidos</h2>
                          <p className="text-sm text-[var(--ds-text-muted)]">Refine sem abrir um construtor completo.</p>
                        </div>
                        <button className="text-xs text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]">Limpar</button>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--ds-text-secondary)]">
                        <span className="uppercase tracking-widest text-[var(--ds-text-muted)]">Combinacao</span>
                        <button
                          type="button"
                          onClick={() => setCombineMode('or')}
                          className={`rounded-full border px-3 py-1 ${
                            combineMode === 'or'
                              ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                          }`}
                        >
                          Mais alcance
                        </button>
                        <button
                          type="button"
                          onClick={() => setCombineMode('and')}
                          className={`rounded-full border px-3 py-1 ${
                            combineMode === 'and'
                              ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                          }`}
                        >
                          Mais preciso
                        </button>
                        <span className="text-xs text-[var(--ds-text-muted)]">
                          {combineModeLabel}: {combinePreview}
                        </span>
                        <span className="text-xs text-[var(--ds-text-muted)]">
                          Estimativa: {isSegmentCountLoading ? 'Calculando...' : `${audienceCount} contatos`}
                        </span>
                      </div>
                      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                        <div>
                          <p className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Tags</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {tagChips.length === 0 && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Sem tags cadastradas</span>
                            )}
                            {tagChips.map((tag) => {
                              const count = tagCounts[tag]
                              const active = selectedTags.includes(tag)
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => toggleSelection(tag, selectedTags, setSelectedTags)}
                                  className={`rounded-full border px-3 py-1 text-xs ${
                                    active
                                      ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100'
                                      : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                                  }`}
                                >
                                  <span>{tag}</span>
                                  {typeof count === 'number' && (
                                    <sup className="ml-1 text-[8px] leading-none text-amber-700 dark:text-amber-300">{count}</sup>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Pais (DDI)</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {countriesQuery.isLoading && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Carregando DDI...</span>
                            )}
                            {!countriesQuery.isLoading && countryChips.length === 0 && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Sem DDI cadastrados</span>
                            )}
                            {countryChips.map((chip) => {
                              const active = selectedCountries.includes(chip)
                              const count = countryCounts[chip]
                              return (
                                <button
                                  key={chip}
                                  type="button"
                                  onClick={() => {
                                    if (combineMode === 'and') {
                                      setSelectedCountries(active ? [] : [chip])
                                      if (!active && chip !== 'BR') {
                                        setSelectedStates([])
                                      }
                                      return
                                    }
                                    toggleSelection(chip, selectedCountries, setSelectedCountries)
                                  }}
                                  className={`rounded-full border px-3 py-1 text-xs ${
                                    active
                                      ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100'
                                      : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                                  }`}
                                >
                                  <span>{chip}</span>
                                  {typeof count === 'number' && (
                                    <sup className="ml-1 text-[8px] leading-none text-amber-700 dark:text-amber-300">{count}</sup>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">UF (BR)</p>
                          <div className="mt-3 flex items-center gap-2 overflow-hidden">
                            {statesQuery.isLoading && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Carregando UFs...</span>
                            )}
                            {!statesQuery.isLoading && stateChips.length === 0 && (
                              <span className="text-xs text-[var(--ds-text-muted)]">Sem UFs cadastrados</span>
                            )}
                            {stateChipsToShow.map((chip) => {
                              const active = selectedStates.includes(chip)
                              const disabled = !isBrSelected
                              const count = stateCounts[chip]
                              return (
                                <button
                                  key={chip}
                                  type="button"
                                  disabled={disabled}
                                  aria-disabled={disabled}
                                  onClick={() => {
                                    if (disabled) return
                                    if (combineMode === 'and') {
                                      setSelectedStates(active ? [] : [chip])
                                      return
                                    }
                                    toggleSelection(chip, selectedStates, setSelectedStates)
                                  }}
                                  className={`rounded-full border px-3 py-1 text-xs ${
                                    active
                                      ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100'
                                      : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                                  } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                                >
                                  <span>{chip}</span>
                                  {typeof count === 'number' && (
                                    <sup className="ml-1 text-[8px] leading-none text-amber-700 dark:text-amber-300">{count}</sup>
                                  )}
                                </button>
                              )
                            })}
                            {!statesQuery.isLoading && hiddenStateCount > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isBrSelected) return
                                  setStateSearch('')
                                  setShowStatesPanel(true)
                                }}
                                className={`rounded-full border px-3 py-1 text-xs ${
                                  isBrSelected
                                    ? 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)] hover:border-white/30'
                                    : 'cursor-not-allowed border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-muted)]'
                                }`}
                              >
                                +{hiddenStateCount}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {audienceMode === 'teste' && (
                <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Contato de teste</h2>
                    <p className="text-sm text-[var(--ds-text-muted)]">Escolha o contato configurado, outro contato, ou ambos.</p>
                  </div>
                  <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                      <div className="flex items-center justify-between">
                        <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Telefone de teste (settings)</label>
                        <a href="/settings#test-contact" className="text-xs text-emerald-700 dark:text-emerald-300">
                          Editar em configuracoes
                        </a>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (!hasConfiguredContact) return
                          setSendToConfigured((prev) => !prev)
                        }}
                        className={`mt-3 w-full rounded-xl border bg-[var(--ds-bg-elevated)] px-4 py-3 text-left text-sm ${
                          sendToConfigured && hasConfiguredContact
                            ? 'border-emerald-600 dark:border-emerald-400/40 text-[var(--ds-text-primary)]'
                            : 'border-[var(--ds-border-default)] text-[var(--ds-text-secondary)]'
                        } ${!hasConfiguredContact ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        {configuredLabel}
                      </button>
                      {hasConfiguredContact ? (
                        <p className="mt-2 text-xs text-[var(--ds-text-muted)]">Clique para incluir/remover no envio.</p>
                      ) : (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Nenhum telefone de teste configurado.</p>
                      )}
                    </div>
                    <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                      <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Usar outro contato</label>
                      <input
                        className="mt-2 w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-4 py-3 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)]"
                        placeholder="Nome, telefone ou e-mail..."
                        value={testContactSearch}
                        onChange={(event) => setTestContactSearch(event.target.value)}
                      />
                      {testContactSearch.trim().length < 2 && !selectedTestContact && (
                        <p className="mt-2 text-xs text-[var(--ds-text-muted)]">Digite pelo menos 2 caracteres para buscar.</p>
                      )}
                      {contactSearchQuery.isLoading && (
                        <p className="mt-2 text-xs text-[var(--ds-text-muted)]">Buscando contatos...</p>
                      )}
                      {contactSearchQuery.isError && (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Erro ao buscar contatos.</p>
                      )}
                      <div className="mt-3 space-y-2 text-sm text-[var(--ds-text-secondary)]">
                        {displayTestContacts.map((contact) => {
                          const isSelected = selectedTestContact?.id === contact.id
                          const isActive = isSelected && sendToSelected
                          return (
                            <button
                              key={contact.id}
                              type="button"
                              onClick={() => {
                                if (isSelected) {
                                  setSendToSelected((prev) => !prev)
                                } else {
                                  setSelectedTestContact(contact)
                                  setSendToSelected(true)
                                }
                              }}
                              className={`w-full rounded-xl border bg-[var(--ds-bg-elevated)] px-3 py-2 text-left transition ${
                                isActive
                                  ? 'border-emerald-600 dark:border-emerald-400/40 text-[var(--ds-text-primary)]'
                                  : isSelected
                                    ? 'border-[var(--ds-border-default)] text-[var(--ds-text-secondary)]'
                                    : 'border-[var(--ds-border-default)] text-[var(--ds-text-secondary)] hover:border-emerald-600 dark:hover:border-emerald-400/40'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-[var(--ds-text-primary)]">{contact.name || 'Contato'}</span>
                                <span className="text-xs text-[var(--ds-text-muted)]">{contact.phone}</span>
                              </div>
                              {contact.email && <div className="mt-1 text-xs text-[var(--ds-text-muted)]">{contact.email}</div>}
                            </button>
                          )
                        })}
                        {!displayTestContacts.length &&
                          testContactSearch.trim().length >= 2 &&
                          !contactSearchQuery.isLoading && (
                            <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-xs text-[var(--ds-text-muted)]">
                              Nenhum contato encontrado.
                            </div>
                          )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4">
                    <p className="text-xs text-[var(--ds-text-muted)]">
                      Envio de teste não consome limite diário. Selecione 1 ou 2 contatos.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Validação de destinatários</h2>
                  <p className="text-sm text-[var(--ds-text-muted)]">Validação automática antes do disparo.</p>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                    <p className="text-2xl font-semibold text-[var(--ds-text-primary)]">
                      {isPrecheckLoading ? '—' : precheckTotals?.valid ?? '—'}
                    </p>
                    <p className="text-xs text-[var(--ds-text-muted)]">Válidos</p>
                  </div>
                  <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                    <p className="text-2xl font-semibold text-amber-700 dark:text-amber-300">
                      {isPrecheckLoading ? '—' : precheckTotals?.skipped ?? '—'}
                    </p>
                    <p className="text-xs text-[var(--ds-text-muted)]">Ignorados</p>
                  </div>
                  <div className="rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4 text-center">
                    <p className="text-2xl font-semibold text-emerald-700 dark:text-emerald-300">
                      {precheckError
                        ? 'Falhou'
                        : isPrecheckLoading
                          ? '...'
                          : precheckTotals && precheckTotals.skipped > 0
                            ? 'Atencao'
                            : 'OK'}
                    </p>
                    <p className="text-xs text-[var(--ds-text-muted)]">Status</p>
                  </div>
                </div>
                {precheckError && (
                  <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{precheckError}</p>
                )}

                {precheckTotals && precheckTotals.skipped > 0 && (
                  <div className="mt-5 rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-[var(--ds-text-primary)]">Corrigir ignorados</p>
                        <p className="text-xs text-[var(--ds-text-muted)]">
                          Alguns contatos estão sendo ignorados por falta de Nome, E-mail ou campo personalizado. Corrija e a validação destrava.
                        </p>
                      </div>
                      <div className="flex items-center justify-end gap-2 sm:flex-nowrap">
                        <button
                          type="button"
                          disabled={!bulkKeys.length}
                          onClick={() => {
                            setBulkError(null)
                            setBulkOpen(true)
                          }}
                          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                            bulkKeys.length
                              ? 'border-amber-400 dark:border-amber-500/20 bg-[var(--ds-bg-elevated)] text-amber-700 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-500/15 hover:border-amber-500 dark:hover:border-amber-500/40'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-muted)]'
                          }`}
                        >
                          <Layers size={16} className={bulkKeys.length ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--ds-text-muted)]'} />
                          <span className="whitespace-nowrap">Aplicar em massa</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => runPrecheck()}
                          className="inline-flex items-center gap-2 rounded-lg border border-transparent bg-primary-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700 dark:bg-white dark:text-black dark:hover:bg-gray-200"
                        >
                          <RefreshCw size={16} />
                          <span className="whitespace-nowrap">Validar novamente</span>
                        </button>
                        <button
                          type="button"
                          disabled={!fixCandidates.length}
                          onClick={startBatchFix}
                          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                            fixCandidates.length
                              ? 'border-primary-500/40 bg-primary-600 text-[var(--ds-text-primary)] hover:bg-primary-500'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-muted)]'
                          }`}
                        >
                          <Wand2 size={16} className={fixCandidates.length ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'} />
                          <span className="whitespace-nowrap">Corrigir em lote</span>
                        </button>
                      </div>
                    </div>

                    {bulkOpen && (
                      <div className="mt-4 rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-[var(--ds-text-primary)]">Aplicar campo personalizado em massa</p>
                            <p className="mt-1 text-xs text-[var(--ds-text-muted)]">
                              Preenche o campo selecionado para todos os contatos ignorados que estão faltando esse dado.
                            </p>
                            {(systemMissingCounts.name > 0 || systemMissingCounts.email > 0) && (
                              <p className="mt-2 text-xs text-[var(--ds-text-muted)]">
                                Obs: {systemMissingCounts.name > 0 ? `${systemMissingCounts.name} faltam Nome` : null}
                                {systemMissingCounts.name > 0 && systemMissingCounts.email > 0 ? ' e ' : null}
                                {systemMissingCounts.email > 0 ? `${systemMissingCounts.email} faltam E-mail` : null}
                                {' — isso não é preenchido aqui; use “Corrigir em lote”.'}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (bulkLoading) return
                              setBulkOpen(false)
                              setBulkError(null)
                            }}
                            className={`text-sm ${bulkLoading ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'}`}
                          >
                            Fechar
                          </button>
                        </div>

                        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                          <div className="space-y-2">
                            <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Campo</label>
                            <select
                              className="w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-sm text-[var(--ds-text-primary)]"
                              value={bulkKey}
                              onChange={(e) => setBulkKey(e.target.value)}
                              disabled={bulkLoading}
                            >
                              {bulkKeys.map((k) => (
                                <option key={k} value={k}>
                                  {(customFieldLabelByKey[k] || k) + ` (${bulkCustomFieldTargets[k]?.length ?? 0})`}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Valor</label>
                            <input
                              className="w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-sm text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)]"
                              placeholder="Ex.: teste"
                              value={bulkValue}
                              onChange={(e) => setBulkValue(e.target.value)}
                              disabled={bulkLoading}
                            />
                            <p className="text-xs text-[var(--ds-text-muted)]">
                              Afetados: <span className="text-[var(--ds-text-secondary)]">{bulkKey ? (bulkCustomFieldTargets[bulkKey]?.length ?? 0) : 0}</span>
                            </p>
                            <p className="text-[11px] text-[var(--ds-text-muted)]">
                              Dica: “Aplicar em massa” só resolve campos personalizados. Se algum ignorado pedir Nome/E-mail, ele aparece no “Corrigir em lote”.
                            </p>
                          </div>
                        </div>

                        {bulkError && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{bulkError}</p>}

                        <div className="mt-4 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (bulkLoading) return
                              setBulkOpen(false)
                              setBulkError(null)
                            }}
                            className="inline-flex items-center gap-2 rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-sm font-semibold text-[var(--ds-text-primary)] transition-colors hover:border-[var(--ds-border-default)]"
                            disabled={bulkLoading}
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={applyBulkCustomField}
                            disabled={bulkLoading}
                            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                              !bulkLoading
                                ? 'border-amber-400 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-500/15 hover:border-amber-500 dark:hover:border-amber-500/50'
                                : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-muted)]'
                            }`}
                          >
                            {bulkLoading ? 'Aplicando...' : 'Aplicar agora'}
                          </button>
                        </div>
                      </div>
                    )}

                    {fixCandidates.length > 0 && (
                      <div className="mt-4 max-h-44 space-y-2 overflow-y-auto pr-2">
                        {fixCandidates.map((c) => (
                          <div
                            key={c.contactId}
                            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[var(--ds-text-primary)]">{c.subtitle}</p>
                              <p className="truncate text-xs text-[var(--ds-text-muted)]">{c.title}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => openQuickEdit({ contactId: c.contactId, focus: c.focus, title: c.title })}
                              className="shrink-0 rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-text-primary)] transition-colors hover:border-[var(--ds-border-default)]"
                            >
                              Corrigir
                            </button>
                          </div>
                        ))}

                        {fixCandidates.length > 3 && (
                          <p className="pt-1 text-xs text-[var(--ds-text-muted)]">Role para ver todos ou use "Corrigir em lote".</p>
                        )}
                      </div>
                    )}

                    {/* Checkbox para prosseguir apenas com válidos */}
                    <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-3 transition-colors hover:bg-[var(--ds-bg-hover)]">
                      <input
                        type="checkbox"
                        checked={skipIgnored}
                        onChange={(e) => setSkipIgnored(e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-primary-500 focus:ring-primary-500 focus:ring-offset-0"
                      />
                      <span className="text-sm text-[var(--ds-text-secondary)]">
                        Prosseguir apenas com os <strong className="text-[var(--ds-text-primary)]">{precheckTotals?.valid ?? 0}</strong> contatos válidos
                      </span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Agendamento</h2>
                  <p className="text-sm text-[var(--ds-text-muted)]">Defina se o envio será agora ou programado.</p>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setScheduleMode('imediato')}
                    className={`rounded-xl border px-4 py-3 text-left text-sm ${
                      scheduleMode === 'imediato'
                        ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                        : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                    }`}
                  >
                    Imediato
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode('agendar')}
                    className={`rounded-xl border px-4 py-3 text-left text-sm ${
                      scheduleMode === 'agendar'
                        ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                        : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)]'
                    }`}
                  >
                    Agendar
                  </button>
                </div>
                <div className={`mt-4 transition ${scheduleMode === 'agendar' ? 'opacity-100' : 'opacity-40'}`}>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Data</label>
                      <Dialog.Root open={isDatePickerOpen} onOpenChange={setIsDatePickerOpen}>
                        <Dialog.Trigger asChild>
                          <button
                            type="button"
                            disabled={scheduleMode !== 'agendar'}
                            className="w-full rounded-xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-4 py-3 text-sm text-[var(--ds-text-primary)] flex items-center justify-between gap-3 disabled:opacity-50"
                          >
                            <span className={scheduleDate ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'}>{formatDateLabel(scheduleDate)}</span>
                            <CalendarIcon size={16} className="text-emerald-400" />
                          </button>
                        </Dialog.Trigger>
                        <Dialog.Portal>
                          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-fit max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-500/20 bg-[var(--ds-bg-base)] p-3 text-[var(--ds-text-primary)] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
                            <div className="flex justify-center">
                              <Calendar
                                mode="single"
                                selected={parsePickerDate(scheduleDate)}
                                onSelect={(date) => {
                                  if (!date) return
                                  setScheduleDate(date.toLocaleDateString('en-CA'))
                                  setIsDatePickerOpen(false)
                                }}
                                fromDate={new Date()}
                                locale={ptBR}
                                className="w-fit rounded-xl border border-emerald-500/10 bg-[var(--ds-bg-base)] p-2"
                              />
                            </div>

                            <div className="mt-3 w-full">
                              <button
                                type="button"
                                onClick={() => setIsDatePickerOpen(false)}
                                className="h-11 w-full rounded-xl bg-emerald-500 text-black font-semibold hover:bg-emerald-400 transition-colors"
                              >
                                Confirmar
                              </button>
                            </div>
                          </Dialog.Content>
                        </Dialog.Portal>
                      </Dialog.Root>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Horário</label>
                      <DateTimePicker value={scheduleTime} onChange={(value) => setScheduleTime(value)} disabled={scheduleMode !== 'agendar'} />
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-[var(--ds-text-muted)]">Fuso do navegador: {userTimeZone || 'Local'}.</p>
                </div>
              </div>

              {/* Organização - Seleção de Pasta */}
              {folders.length > 0 && (
                <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">Organização</h2>
                    <p className="text-sm text-[var(--ds-text-muted)]">Salve em uma pasta para organizar suas campanhas (opcional).</p>
                  </div>
                  <div className="mt-4">
                    <label className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Pasta</label>
                    <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                      {/* Opção "Nenhuma" */}
                      <button
                        type="button"
                        onClick={() => setSelectedFolderId(null)}
                        className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-left text-sm transition ${
                          selectedFolderId === null
                            ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                            : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)] hover:border-[var(--ds-border-default)]'
                        }`}
                      >
                        <FolderIcon size={16} className="text-[var(--ds-text-muted)]" />
                        <span>Nenhuma</span>
                      </button>
                      {/* Pastas disponíveis */}
                      {folders.map((folder) => (
                        <button
                          key={folder.id}
                          type="button"
                          onClick={() => setSelectedFolderId(folder.id)}
                          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-left text-sm transition ${
                            selectedFolderId === folder.id
                              ? 'border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                              : 'border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] text-[var(--ds-text-secondary)] hover:border-[var(--ds-border-default)]'
                          }`}
                        >
                          <FolderIcon size={16} style={{ color: folder.color }} />
                          <span className="truncate">{folder.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <ContactQuickEditModal
            isOpen={Boolean(quickEditContactId)}
            contactId={quickEditContactId}
            onClose={handleQuickEditClose}
            onSaved={handleQuickEditSaved}
            focus={quickEditFocus}
            title={quickEditTitle}
            mode="focused"
            showNameInFocusedMode={false}
          />

          <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <button
                type="button"
                onClick={() => {
                  if (isLaunching) return
                  // Passo 1 tem "sub-etapas": escolher template -> preencher variáveis
                  if (step === 1) {
                    if (templateSelected) {
                      // Volta para a seleção de template
                      setTemplateSelected(false)
                      setPreviewTemplate(null)
                      return
                    }
                    if (showAllTemplates) {
                      // Se estiver na lista completa, volta para a lista de recentes
                      setShowAllTemplates(false)
                      return
                    }

                    // No primeiro passo (seleção), Voltar leva ao Dashboard
                    router.push('/')
                    return
                  }

                  // Demais passos: volta para o passo anterior
                  setStep(step - 1)
                }}
                className={`text-sm transition ${
                  isLaunching ? 'cursor-not-allowed text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                Voltar
              </button>
              <div className="text-center text-sm text-[var(--ds-text-secondary)]">
                {step === 1 && !templateSelected && 'Selecione um template para continuar'}
                {step === 1 && templateSelected && missingTemplateVars > 0 && (
                  <>Preencha {missingTemplateVars} variável(is) obrigatória(s)</>
                )}
                {step === 1 && templateSelected && missingTemplateVars === 0 && !campaignName.trim() && (
                  <>Defina o nome da campanha</>
                )}
                {step === 2 && !isAudienceComplete && 'Selecione um público válido'}
                {step === 3 && isPrecheckLoading && 'Validando destinatários...'}
                {step === 3 && !isPrecheckLoading && precheckNeedsFix && !skipIgnored && 'Corrija os ignorados ou marque para prosseguir apenas com válidos'}
                {step === 3 && !isPrecheckLoading && precheckTotals && (precheckTotals.valid ?? 0) === 0 && 'Nenhum destinatário válido — corrija os ignorados'}
                {step === 4 && !isScheduleComplete && 'Defina data e horário do agendamento'}
                {canContinue && footerSummary}
              </div>
              <div className="flex items-center gap-3">
                {/* Botão Salvar Rascunho (só no step 4) */}
                {step === 4 && (
                  <button
                    onClick={handleSaveDraft}
                    className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                      canContinue && !isLaunching && !isSavingDraft
                        ? 'border border-[var(--ds-border-default)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text-primary)]'
                        : 'cursor-not-allowed border border-[var(--ds-border-default)] text-[var(--ds-text-muted)]'
                    }`}
                    disabled={!canContinue || isLaunching || isSavingDraft}
                  >
                    <Save size={16} />
                    {isSavingDraft ? 'Salvando...' : 'Salvar Rascunho'}
                  </button>
                )}

                {/* Botão Continuar / Lançar */}
                <button
                  onClick={async () => {
                    if (!canContinue || isLaunching || isSavingDraft) return
                    if (step === 1) {
                      setStep(2)
                      return
                    }
                    if (step === 2) {
                      const result = await runPrecheck()
                      const totals = result?.totals
                      const skipped = totals?.skipped ?? 0
                      const valid = totals?.valid ?? 0
                      if (!result || skipped > 0 || valid === 0) {
                        setStep(3)
                        return
                      }
                      setStep(4)
                      return
                    }
                    if (step === 3) {
                      if (!isPrecheckOk) return
                      setStep(4)
                      return
                    }
                    handleLaunch()
                  }}
                  className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
                    canContinue && !isLaunching && !isSavingDraft
                      ? 'bg-primary-600 text-white dark:bg-white dark:text-black'
                      : 'cursor-not-allowed border border-[var(--ds-border-default)] bg-[var(--ds-bg-hover)] text-[var(--ds-text-muted)]'
                  }`}
                  disabled={!canContinue || isLaunching || isSavingDraft}
                >
                  {step < 4 ? 'Continuar' : isLaunching ? 'Lancando...' : 'Lancar campanha'}
                </button>
              </div>
            </div>
            {launchError && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{launchError}</p>
            )}
          </div>
        </div>

        <div className={`flex h-full flex-col gap-4 ${step === 2 ? 'lg:sticky lg:top-6' : ''}`}>
          <div className="rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-6 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Resumo</div>
              <button className="rounded-full border border-emerald-600 dark:border-emerald-400/40 bg-emerald-100 dark:bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-200">
                Campanha Rapida
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm">
              {/* Contatos e Custo só aparecem a partir do Step 2 (quando faz sentido) */}
              {step >= 2 && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--ds-text-muted)]">Contatos</span>
                    <span className="text-[var(--ds-text-primary)]">{displayAudienceCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--ds-text-muted)]">Custo</span>
                    <span className="text-emerald-700 dark:text-emerald-300">{displayAudienceCost}</span>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[var(--ds-text-muted)]">Custo Base</span>
                <div className="text-right">
                  <div className="text-emerald-700 dark:text-emerald-300">{basePricePerMessage}/msg</div>
                  <div className="text-[10px] text-[var(--ds-text-muted)]">
                    {selectedTemplate?.category || '—'} • {exchangeRateLabel}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--ds-text-muted)]">Agendamento</span>
                <span className="text-[var(--ds-text-primary)]">{scheduleSummaryLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--ds-text-muted)]">Nome</span>
                <span className="text-[var(--ds-text-primary)]">{campaignName.trim() || '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--ds-text-muted)]">Template</span>
                <span className="text-[var(--ds-text-primary)]">{templateSelected ? selectedTemplate?.name || '—' : '—'}</span>
              </div>
              {/* Público só aparece a partir do Step 2 */}
              {step >= 2 && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--ds-text-muted)]">Público</span>
                  <span className="text-[var(--ds-text-primary)]">
                    {audienceMode === 'teste'
                      ? `${selectedTestCount || 0} contato(s) de teste`
                      : isSegmentCountLoading
                        ? 'Calculando...'
                        : `${effectiveAudienceCount} contatos`}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 rounded-2xl border border-[var(--ds-border-default)] bg-[var(--ds-bg-surface)] p-8 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-widest text-[var(--ds-text-muted)]">Preview</div>
              <button className="text-xs text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]">Expandir</button>
            </div>
            <div className="mt-6 text-sm text-[var(--ds-text-secondary)]">
              {activeTemplate ? (
                <>
                  <div>
                    <TemplatePreviewCard
                      templateName={activeTemplate.name}
                      components={templateComponents}
                      parameterFormat={parameterFormat}
                      variables={Array.isArray(resolvedBody) ? resolvedBody : undefined}
                      headerVariables={Array.isArray(resolvedHeader) ? resolvedHeader : undefined}
                      namedVariables={!Array.isArray(resolvedBody) && resolvedBody ? (resolvedBody as Record<string, string>) : undefined}
                      namedHeaderVariables={!Array.isArray(resolvedHeader) && resolvedHeader ? (resolvedHeader as Record<string, string>) : undefined}
                      headerMediaPreviewUrl={activeTemplate.headerMediaPreviewUrl || headerExampleUrl || null}
                      fallbackContent={activeTemplate.content || activeTemplate.preview}
                    />
                  </div>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-[var(--ds-text-primary)]">Selecione um template</p>
                  <p className="mt-3 text-sm text-[var(--ds-text-muted)]">O preview aparece aqui quando você escolher.</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <CustomFieldsSheet
        open={isFieldsSheetOpen}
        onOpenChange={setIsFieldsSheetOpen}
        entityType="contact"
      />
    </div>
  )
}
