'use client'

/**
 * Atendimento Layout - Geist Design System
 *
 * Suporta dark/light mode via CSS classes e variáveis CSS.
 * As variáveis são injetadas via <style> tag para garantir
 * que o CSS cascade funcione corretamente com Tailwind.
 */

import { ReactNode, Suspense, createContext, useContext, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { AttendantProvider } from '@/components/attendant/AttendantProvider'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

// =============================================================================
// Query Client
// =============================================================================

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 10,
      refetchOnWindowFocus: true,
    },
  },
})

// =============================================================================
// Theme CSS - Injected via <style> tag for proper CSS cascade
// =============================================================================

const THEME_CSS = `
  .geist-theme {
    /* Light theme - softer off-white for eye comfort */
    --geist-background: #f0f2f5;
    --geist-background-secondary: #ffffff;
    --geist-foreground: #1a1a1a;
    --geist-foreground-secondary: #54656f;
    --geist-foreground-tertiary: #8696a0;
    --geist-border: #e9edef;
    --geist-border-hover: #d1d7db;
    --geist-component-bg: #ffffff;
    --geist-component-bg-hover: #f5f6f6;

    /* Accent colors - Geist vibrant palette */
    --geist-accent: #0070f3;
    --geist-accent-hover: #0060df;
    --geist-accent-foreground: #ffffff;

    /* Semantic colors - Geist palette */
    --geist-blue: #0070f3;
    --geist-blue-light: #d3e5ff;
    --geist-blue-dark: #0060df;
    --geist-green: #17c964;
    --geist-green-light: #d1f4e0;
    --geist-green-dark: #13a452;
    --geist-red: #f31260;
    --geist-red-light: #fdd8e5;
    --geist-red-dark: #c20e4d;
    --geist-amber: #f5a623;
    --geist-amber-light: #fff4d4;
    --geist-amber-dark: #c68419;
    --geist-purple: #6366f1;
    --geist-purple-light: #e0e7ff;
    --geist-teal: #06b6d4;
    --geist-teal-light: #cffafe;

    /* Mapped semantic colors */
    --geist-success: var(--geist-green);
    --geist-success-light: var(--geist-green-light);
    --geist-error: var(--geist-red);
    --geist-error-light: var(--geist-red-light);
    --geist-warning: var(--geist-amber);
    --geist-warning-light: var(--geist-amber-light);
    --geist-info: var(--geist-blue);
    --geist-info-light: var(--geist-blue-light);

    /* Chat specific - cores do WhatsApp light mode */
    --chat-bubble-outbound: #d9fdd3;
    --chat-bubble-outbound-text: #111b21;
    --chat-bubble-inbound: #ffffff;
    --chat-bubble-inbound-text: #111b21;
    --chat-timestamp: #667781;
    --chat-status-read: #53bdeb;

    /* Avatar colors */
    --geist-avatar-ai: var(--geist-purple);
    --geist-avatar-human: var(--geist-teal);
    --geist-avatar-urgent: var(--geist-red);
  }

  .geist-theme.geist-dark {
    /* Dark theme - Geist Color System */
    --geist-background: #000000;
    --geist-background-secondary: #111111;
    --geist-foreground: #ededed;
    --geist-foreground-secondary: #a1a1a1;
    --geist-foreground-tertiary: #888888;
    --geist-border: #333333;
    --geist-border-hover: #444444;
    --geist-component-bg: #1a1a1a;
    --geist-component-bg-hover: #252525;

    /* Accent colors - Geist vibrant palette (dark mode) */
    --geist-accent: #0070f3;
    --geist-accent-hover: #3291ff;
    --geist-accent-foreground: #ffffff;

    /* Semantic colors - Geist palette (brighter for dark mode) */
    --geist-blue: #3291ff;
    --geist-blue-light: #0d2847;
    --geist-blue-dark: #0070f3;
    --geist-green: #45d483;
    --geist-green-light: #0d3321;
    --geist-green-dark: #17c964;
    --geist-red: #f5426c;
    --geist-red-light: #3d0d1a;
    --geist-red-dark: #f31260;
    --geist-amber: #ffb224;
    --geist-amber-light: #3d2e0d;
    --geist-amber-dark: #f5a623;
    --geist-purple: #818cf8;
    --geist-purple-light: #1e1b4b;
    --geist-teal: #22d3ee;
    --geist-teal-light: #083344;

    /* Mapped semantic colors */
    --geist-success: var(--geist-green);
    --geist-success-light: var(--geist-green-light);
    --geist-error: var(--geist-red);
    --geist-error-light: var(--geist-red-light);
    --geist-warning: var(--geist-amber);
    --geist-warning-light: var(--geist-amber-light);
    --geist-info: var(--geist-blue);
    --geist-info-light: var(--geist-blue-light);

    /* Chat specific - cores do WhatsApp dark mode */
    --chat-bubble-outbound: #005c4b;
    --chat-bubble-outbound-text: #e9edef;
    --chat-bubble-inbound: #202c33;
    --chat-bubble-inbound-text: #e9edef;
    --chat-timestamp: #8696a0;
    --chat-status-read: #53bdeb;

    /* Avatar colors */
    --geist-avatar-ai: var(--geist-purple);
    --geist-avatar-human: var(--geist-teal);
    --geist-avatar-urgent: var(--geist-red);
  }
`

// =============================================================================
// Theme Context
// =============================================================================

type Theme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('atendimento-theme') as Theme | null
    if (stored === 'light' || stored === 'dark') {
      setThemeState(stored)
    }
    setMounted(true)
  }, [])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
    localStorage.setItem('atendimento-theme', newTheme)
  }

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0a0a0a' }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#666' }} />
      </div>
    )
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: theme, setTheme }}>
      {/* Inject theme CSS */}
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />

      {/* Theme wrapper with CSS class-based theming */}
      <div
        className={`geist-theme min-h-screen ${theme === 'dark' ? 'geist-dark' : ''}`}
        style={{
          backgroundColor: 'var(--geist-background)',
          color: 'var(--geist-foreground)',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        }}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  )
}

// =============================================================================
// Layout Inner
// =============================================================================

function AttendimentoLayoutInner({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  // Override root admin manifest so A2HS from /atendimento installs the attendant PWA
  useEffect(() => {
    const existing = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null
    if (existing) {
      existing.href = '/manifest-atendimento.json'
      return
    }
    const link = document.createElement('link')
    link.rel = 'manifest'
    link.href = '/manifest-atendimento.json'
    document.head.appendChild(link)
  }, [])

  return (
    <AttendantProvider token={token}>
      <ThemeProvider>
        {children}
      </ThemeProvider>
    </AttendantProvider>
  )
}

// =============================================================================
// Layout Principal
// =============================================================================

export default function AtendimentoLayout({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0a0a0a' }}>
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#666' }} />
          </div>
        }
      >
        <AttendimentoLayoutInner>{children}</AttendimentoLayoutInner>
      </Suspense>
    </QueryClientProvider>
  )
}
