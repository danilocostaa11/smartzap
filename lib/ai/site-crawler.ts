/**
 * Site crawler for AI knowledge base import.
 * BFS same-host crawl with fetch + jsdom (no external scrape API).
 */

import { JSDOM } from 'jsdom'

export const SITE_CRAWL_MAX_PAGES = 15
export const SITE_CRAWL_MAX_DEPTH = 2
const PAGE_TIMEOUT_MS = 15_000
const MAX_PAGE_CHARS = 80_000
const USER_AGENT =
  'SmartZapKnowledgeBot/1.0 (+https://smartzapv2-two.vercel.app; knowledge-base-import)'

const SKIP_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.mp3',
  '.mp4',
  '.wav',
  '.zip',
  '.rar',
  '.gz',
  '.css',
  '.js',
  '.mjs',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.xml',
  '.rss',
  '.atom',
])

export interface CrawledPage {
  url: string
  title: string
  markdown: string
}

export interface SiteCrawlResult {
  seedUrl: string
  hostname: string
  pages: CrawledPage[]
  errors: string[]
}

export function normalizeSeedUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('URL é obrigatória')
  }

  // Só adiciona https se não houver esquema explícito (evita https://ftp://...)
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error('URL inválida')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL deve usar http ou https')
  }

  parsed.hash = ''
  return parsed
}

function canonicalizeUrl(url: URL): string {
  const copy = new URL(url.href)
  copy.hash = ''
  // Remove trailing slash except for root
  if (copy.pathname.length > 1 && copy.pathname.endsWith('/')) {
    copy.pathname = copy.pathname.slice(0, -1)
  }
  return copy.href
}

function isSkippablePath(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  const lastDot = lower.lastIndexOf('.')
  if (lastDot === -1) return false
  const ext = lower.slice(lastDot)
  return SKIP_EXTENSIONS.has(ext)
}

function sameHost(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./i, '') === b.hostname.replace(/^www\./i, '')
}

function extractLinks(doc: Document, baseUrl: URL, seed: URL): string[] {
  const links: string[] = []
  const anchors = doc.querySelectorAll('a[href]')

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href')
    if (!href) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue
    }

    let resolved: URL
    try {
      resolved = new URL(href, baseUrl)
    } catch {
      continue
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (!sameHost(resolved, seed)) continue
    if (isSkippablePath(resolved.pathname)) continue

    links.push(canonicalizeUrl(resolved))
  }

  return links
}

function extractPageContent(html: string, pageUrl: string): { title: string; markdown: string } {
  const dom = new JSDOM(html, { url: pageUrl })
  const { document } = dom.window

  for (const el of document.querySelectorAll(
    'script, style, noscript, iframe, svg, canvas, nav, footer, header, aside, form, [role="navigation"], [aria-hidden="true"]'
  )) {
    el.remove()
  }

  const title =
    document.querySelector('title')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim() ||
    pageUrl

  const main =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.querySelector('[role="main"]') ||
    document.body

  const text = (main?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  const clipped = text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[...conteúdo truncado]` : text

  const markdown = `# ${title}\n\nSource: ${pageUrl}\n\n${clipped || '_Página sem texto extraível._'}`

  return { title, markdown }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`Tipo não suportado: ${contentType.split(';')[0]}`)
    }

    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Crawl a website starting from seedUrl (same host, BFS, limited pages/depth).
 */
export async function crawlSite(
  rawUrl: string,
  options?: { maxPages?: number; maxDepth?: number }
): Promise<SiteCrawlResult> {
  const maxPages = options?.maxPages ?? SITE_CRAWL_MAX_PAGES
  const maxDepth = options?.maxDepth ?? SITE_CRAWL_MAX_DEPTH

  const seed = normalizeSeedUrl(rawUrl)
  const seedCanonical = canonicalizeUrl(seed)
  const hostname = seed.hostname.replace(/^www\./i, '')

  const visited = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = [{ url: seedCanonical, depth: 0 }]
  const pages: CrawledPage[] = []
  const errors: string[] = []

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift()!
    if (visited.has(next.url)) continue
    visited.add(next.url)

    try {
      const html = await fetchHtml(next.url)
      const { title, markdown } = extractPageContent(html, next.url)
      pages.push({ url: next.url, title, markdown })

      if (next.depth < maxDepth) {
        const dom = new JSDOM(html, { url: next.url })
        const links = extractLinks(dom.window.document, new URL(next.url), seed)
        for (const link of links) {
          if (!visited.has(link) && !queue.some((q) => q.url === link)) {
            queue.push({ url: link, depth: next.depth + 1 })
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${next.url}: ${message}`)
    }
  }

  return {
    seedUrl: seedCanonical,
    hostname,
    pages,
    errors,
  }
}

/**
 * Merge crawled pages into a single markdown document for knowledge indexing.
 */
export function mergeCrawledPages(result: SiteCrawlResult): string {
  const header = [
    `# Site: ${result.hostname}`,
    '',
    `Seed: ${result.seedUrl}`,
    `Páginas indexadas: ${result.pages.length}`,
    '',
  ].join('\n')

  const body = result.pages.map((p) => p.markdown).join('\n\n---\n\n')
  return `${header}${body}`
}
