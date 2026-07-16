import { describe, expect, it } from 'vitest'
import {
  precheckContactForTemplate,
  buildMetaTemplatePayload,
  resolveVarValue,
  canonicalizeVarToken,
} from '@/lib/whatsapp/template-contract'

describe('canonicalizeVarToken / resolveVarValue', () => {
  const contact = {
    contactId: 'c_1',
    name: 'Danilo',
    phone: '+5511999999999',
    email: 'danilo@exemplo.com',
    custom_fields: { cidade: 'SP' },
  }

  it('aceita aliases de nome com espaços e lead.name', () => {
    expect(canonicalizeVarToken('{{ nome }}')).toBe('{{nome}}')
    expect(canonicalizeVarToken('lead.name')).toBe('{{nome}}')
    expect(canonicalizeVarToken('{{lead.name}}')).toBe('{{nome}}')
    expect(resolveVarValue('lead.name', contact)).toBe('Danilo')
    expect(resolveVarValue('{{ nome }}', contact)).toBe('Danilo')
    expect(resolveVarValue('{{nome}}', contact)).toBe('Danilo')
  })

  it('mantém texto fixo literal', () => {
    expect(resolveVarValue('Cliente VIP', contact)).toBe('Cliente VIP')
  })
})

const baseTemplate = {
  id: 'tpl_1',
  name: 'test_template',
  category: 'MARKETING',
  language: 'pt_BR',
  status: 'APPROVED',
  content: '',
  preview: '',
  lastUpdated: new Date().toISOString(),
  parameterFormat: 'positional' as const,
  components: [
    { type: 'BODY', text: 'Olá {{1}}' },
  ],
}

describe('template-contract precheckContactForTemplate', () => {
  it('deve marcar como skipped quando token resolve para vazio (ex: {{email}} sem email)', () => {
    const res = precheckContactForTemplate(
      {
        contactId: 'c_1',
        name: 'João',
        phone: '+5511999999999',
        email: null,
        custom_fields: {},
      },
      baseTemplate as any,
      {
        header: [],
        body: ['{{email}}'],
      }
    )

    expect(res.ok).toBe(false)
    if (res.ok) return

    expect(res.skipCode).toBe('MISSING_REQUIRED_PARAM')
    // Observabilidade: deve indicar exatamente a posição + token cru.
    expect(res.reason).toContain('body:1')
    expect(res.reason).toContain('raw="{{email}}"')

    // Estruturado: útil para UI apontar exatamente o que falta
    expect(res.missing).toBeTruthy()
    expect(res.missing?.[0]).toMatchObject({ where: 'body', key: '1', raw: '{{email}}' })
  })

  it('deve passar quando token resolve com valor (ex: {{email}} presente)', () => {
    const res = precheckContactForTemplate(
      {
        contactId: 'c_1',
        name: 'João',
        phone: '+5511999999999',
        email: 'joao@exemplo.com',
        custom_fields: {},
      },
      baseTemplate as any,
      {
        header: [],
        body: ['{{email}}'],
      }
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.normalizedPhone).toBe('+5511999999999')
    expect(res.values.body).toEqual([{ key: '1', text: 'joao@exemplo.com' }])
  })
})

describe('buildMetaTemplatePayload com LOCATION header', () => {
  const locationTemplate = {
    id: 'tpl_loc',
    name: 'location_template',
    category: 'MARKETING',
    language: 'pt_BR',
    status: 'APPROVED',
    content: '',
    preview: '',
    lastUpdated: new Date().toISOString(),
    parameterFormat: 'positional' as const,
    components: [
      { type: 'HEADER', format: 'LOCATION' },
      { type: 'BODY', text: 'Visite nossa loja!' },
    ],
  }

  const locationTemplateWithData = {
    ...locationTemplate,
    components: [
      {
        type: 'HEADER',
        format: 'LOCATION',
        location: {
          latitude: '-23.5505',
          longitude: '-46.6333',
          name: 'Loja Centro',
          address: 'Rua Augusta, 500',
        },
      },
      { type: 'BODY', text: 'Visite nossa loja!' },
    ],
  }

  it('deve construir payload correto com dados de localização passados em values', () => {
    const payload = buildMetaTemplatePayload({
      to: '+5511999999999',
      templateName: 'location_template',
      language: 'pt_BR',
      parameterFormat: 'positional',
      values: {
        body: [],
        headerLocation: {
          latitude: '-23.5505',
          longitude: '-46.6333',
          name: 'Loja São Paulo',
          address: 'Av. Paulista, 1000',
        },
      },
      template: locationTemplate as any,
    })

    expect(payload.template.components).toContainEqual({
      type: 'header',
      parameters: [
        {
          type: 'location',
          location: {
            latitude: '-23.5505',
            longitude: '-46.6333',
            name: 'Loja São Paulo',
            address: 'Av. Paulista, 1000',
          },
        },
      ],
    })
  })

  it('deve extrair dados de localização do template quando não passados em values', () => {
    const payload = buildMetaTemplatePayload({
      to: '+5511999999999',
      templateName: 'location_template',
      language: 'pt_BR',
      parameterFormat: 'positional',
      values: {
        body: [],
      },
      template: locationTemplateWithData as any,
    })

    expect(payload.template.components).toContainEqual({
      type: 'header',
      parameters: [
        {
          type: 'location',
          location: {
            latitude: '-23.5505',
            longitude: '-46.6333',
            name: 'Loja Centro',
            address: 'Rua Augusta, 500',
          },
        },
      ],
    })
  })

  it('deve lançar erro quando template LOCATION não tem dados de localização em nenhum lugar', () => {
    expect(() =>
      buildMetaTemplatePayload({
        to: '+5511999999999',
        templateName: 'location_template',
        language: 'pt_BR',
        parameterFormat: 'positional',
        values: {
          body: [],
        },
        template: locationTemplate as any,
      })
    ).toThrow(/não há dados de localização/)
  })

  it('deve passar headerLocation através do precheck', () => {
    const res = precheckContactForTemplate(
      {
        contactId: 'c_1',
        name: 'João',
        phone: '+5511999999999',
      },
      locationTemplate as any,
      {
        body: [],
        headerLocation: {
          latitude: '-23.5505',
          longitude: '-46.6333',
          name: 'Loja SP',
          address: 'Av. Paulista',
        },
      }
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.values.headerLocation).toEqual({
      latitude: '-23.5505',
      longitude: '-46.6333',
      name: 'Loja SP',
      address: 'Av. Paulista',
    })
  })
})
