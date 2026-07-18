'use client'

import Link from 'next/link'
import { Monitor } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'

interface DesktopOnlyGateProps {
  children: React.ReactNode
  title?: string
  description?: string
  backHref?: string
  backLabel?: string
}

/**
 * Em telas < lg, substitui o conteúdo por um aviso para abrir no desktop.
 * Usado no workflow builder (canvas desktop-first).
 */
export function DesktopOnlyGate({
  children,
  title = 'Disponível no desktop',
  description = 'O editor de fluxos precisa de uma tela maior. Abra no computador para continuar.',
  backHref = '/',
  backLabel = 'Voltar ao início',
}: DesktopOnlyGateProps) {
  const isMobile = useIsMobile()

  if (!isMobile) {
    return <>{children}</>
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-10 text-center pt-safe pb-safe">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--ds-bg-surface)] border border-[var(--ds-border-subtle)]">
        <Monitor className="h-7 w-7 text-[var(--ds-text-muted)]" aria-hidden />
      </div>
      <div className="max-w-sm space-y-2">
        <h2 className="text-lg font-semibold text-[var(--ds-text-primary)]">{title}</h2>
        <p className="text-sm text-[var(--ds-text-secondary)]">{description}</p>
      </div>
      <Link
        href={backHref}
        className="mt-2 inline-flex items-center justify-center rounded-lg bg-primary-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-600 transition-colors"
      >
        {backLabel}
      </Link>
    </div>
  )
}
