'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { WifiOff, RefreshCw } from 'lucide-react'

export default function OfflinePage() {
  const handleRetry = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }, [])

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-6 px-6 py-10 pt-safe pb-safe bg-zinc-950 text-zinc-100">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900 border border-zinc-800">
        <WifiOff className="h-8 w-8 text-zinc-400" aria-hidden />
      </div>

      <div className="max-w-sm text-center space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Você está offline</h1>
        <p className="text-sm text-zinc-400">
          Sem conexão no momento. Verifique a internet e tente novamente.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <button
          type="button"
          onClick={handleRetry}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-600 transition-colors"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Tentar novamente
        </button>
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-900 transition-colors"
        >
          Ir para o login
        </Link>
      </div>
    </main>
  )
}
