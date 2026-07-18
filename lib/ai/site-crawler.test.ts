import { describe, expect, it } from 'vitest'
import { mergeCrawledPages, normalizeSeedUrl, type SiteCrawlResult } from '@/lib/ai/site-crawler'

describe('normalizeSeedUrl', () => {
  it('adds https when protocol is missing', () => {
    const url = normalizeSeedUrl('example.com/path')
    expect(url.href).toBe('https://example.com/path')
  })

  it('rejects empty url', () => {
    expect(() => normalizeSeedUrl('  ')).toThrow('URL é obrigatória')
  })

  it('rejects non-http protocols', () => {
    expect(() => normalizeSeedUrl('ftp://example.com')).toThrow('URL deve usar http ou https')
  })
})

describe('mergeCrawledPages', () => {
  it('joins pages with separators and header', () => {
    const result: SiteCrawlResult = {
      seedUrl: 'https://example.com/',
      hostname: 'example.com',
      pages: [
        {
          url: 'https://example.com/',
          title: 'Home',
          markdown: '# Home\n\nSource: https://example.com/\n\nHello',
        },
        {
          url: 'https://example.com/about',
          title: 'About',
          markdown: '# About\n\nSource: https://example.com/about\n\nWorld',
        },
      ],
      errors: [],
    }

    const merged = mergeCrawledPages(result)
    expect(merged).toContain('# Site: example.com')
    expect(merged).toContain('Páginas indexadas: 2')
    expect(merged).toContain('---')
    expect(merged).toContain('Hello')
    expect(merged).toContain('World')
  })
})
