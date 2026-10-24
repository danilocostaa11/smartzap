'use client'

/**
 * PWAProvider - Componente que gerencia toda a experiência PWA
 *
 * Features:
 * - Registra Service Worker automaticamente
 * - Mostra prompt de instalação quando disponível
 * - Mostra banner de atualização quando há nova versão
 * - Expõe contexto para controle manual
 */

import { createContext, useContext, useEffect, useState } from 'react'
import { Download, RefreshCw, X, Bell, BellOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useServiceWorker } from '@/hooks/useServiceWorker'
import { toast } from 'sonner'
import {
  isInstallDismissedActive,
  PWA_INSTALL_DISMISS_KEY,
} from '@/lib/pwa-install-dismiss'

// =============================================================================
// Context
// =============================================================================

interface PWAContextType {
  isInstallable: boolean
  isUpdateAvailable: boolean
  isPushEnabled: boolean
  pushPermission: NotificationPermission | 'unsupported'
  install: () => Promise<void>
  update: () => Promise<void>
  enablePush: () => Promise<boolean>
  disablePush: () => Promise<boolean>
}

const PWAContext = createContext<PWAContextType | null>(null)

export function usePWA() {
  const context = useContext(PWAContext)
  if (!context) {
    throw new Error('usePWA must be used within PWAProvider')
  }
  return context
}

function readInstallDismissed(): boolean {
  try {
    const raw = localStorage.getItem(PWA_INSTALL_DISMISS_KEY)
    if (!isInstallDismissedActive(raw)) {
      if (raw) localStorage.removeItem(PWA_INSTALL_DISMISS_KEY)
      return false
    }
    return true
  } catch {
    return false
  }
}

function detectMobile(): boolean {
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 1024)
  )
}

// =============================================================================
// Provider Component
// =============================================================================

interface PWAProviderProps {
  children: React.ReactNode
}

export function PWAProvider({ children }: PWAProviderProps) {
  const { sw, push, installPWA, updateSW, subscribeToPush, unsubscribeFromPush } =
    useServiceWorker()

  const [showInstallBanner, setShowInstallBanner] = useState(false)
  const [showUpdateBanner, setShowUpdateBanner] = useState(false)
  const [installDismissed, setInstallDismissed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  // Ler dismiss persistido + detectar mobile após mount (evita hydration mismatch)
  useEffect(() => {
    setInstallDismissed(readInstallDismissed())
    setIsMobile(detectMobile())
  }, [])

  // Banner de instalação após 30s (apenas mobile)
  useEffect(() => {
    if (sw.isInstallable && !installDismissed && isMobile) {
      const timer = setTimeout(() => {
        setShowInstallBanner(true)
      }, 30000)

      return () => clearTimeout(timer)
    }
  }, [sw.isInstallable, installDismissed, isMobile])

  // Update banner com gate: waiting + controller existente (não primeira install)
  useEffect(() => {
    const registration = sw.registration
    if (
      sw.updateAvailable &&
      registration?.waiting &&
      navigator.serviceWorker.controller
    ) {
      setShowUpdateBanner(true)
    }
  }, [sw.updateAvailable, sw.registration])

  const install = async () => {
    await installPWA()
    setShowInstallBanner(false)
  }

  const dismissInstall = () => {
    setShowInstallBanner(false)
    setInstallDismissed(true)
    localStorage.setItem(PWA_INSTALL_DISMISS_KEY, Date.now().toString())
  }

  const update = async () => {
    await updateSW()
    setShowUpdateBanner(false)
  }

  const enablePush = async () => {
    const subscription = await subscribeToPush()
    if (subscription) {
      toast.success('Notificações ativadas!')
      return true
    }
    toast.error('Não foi possível ativar notificações')
    return false
  }

  const disablePush = async () => {
    const success = await unsubscribeFromPush()
    if (success) {
      toast.success('Notificações desativadas')
    }
    return success
  }

  const contextValue: PWAContextType = {
    isInstallable: sw.isInstallable,
    isUpdateAvailable: sw.updateAvailable,
    isPushEnabled: !!push.subscription,
    pushPermission: push.permission,
    install,
    update,
    enablePush,
    disablePush,
  }

  return (
    <PWAContext.Provider value={contextValue}>
      {children}

      {showInstallBanner && (
        <InstallBanner onInstall={install} onDismiss={dismissInstall} />
      )}

      {showUpdateBanner && (
        <UpdateBanner onUpdate={update} onDismiss={() => setShowUpdateBanner(false)} />
      )}
    </PWAContext.Provider>
  )
}

// =============================================================================
// Install Banner
// =============================================================================

interface InstallBannerProps {
  onInstall: () => void
  onDismiss: () => void
}

function InstallBanner({ onInstall, onDismiss }: InstallBannerProps) {
  return (
    <div
      className="fixed left-4 right-4 md:left-auto md:right-4 md:w-80 z-50 animate-in slide-in-from-bottom-4 duration-300"
      style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
            <Download className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100">Instalar SmartZap</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Acesse mais rápido direto da sua tela inicial
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Depois
          </button>
          <button
            type="button"
            onClick={onInstall}
            className="flex-1 px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
          >
            Instalar
          </button>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Update Banner
// =============================================================================

interface UpdateBannerProps {
  onUpdate: () => void
  onDismiss: () => void
}

function UpdateBanner({ onUpdate, onDismiss }: UpdateBannerProps) {
  return (
    <div
      className="fixed left-4 right-4 md:left-auto md:right-4 md:w-80 z-50 animate-in slide-in-from-top-4 duration-300"
      style={{ top: 'max(1rem, env(safe-area-inset-top))' }}
    >
      <div className="bg-emerald-950/90 border border-emerald-800 rounded-xl p-4 shadow-2xl backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
            <RefreshCw className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-emerald-100">Atualização disponível</h3>
            <p className="text-xs text-emerald-300/70 mt-0.5">
              Uma nova versão do SmartZap está pronta
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-emerald-400/60 hover:text-emerald-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 px-3 py-2 text-xs font-medium text-emerald-300/70 hover:text-emerald-200 bg-emerald-900/50 hover:bg-emerald-900/70 rounded-lg transition-colors"
          >
            Depois
          </button>
          <button
            type="button"
            onClick={onUpdate}
            className="flex-1 px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Atualizar
          </button>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Push Toggle Button (para uso em configurações)
// =============================================================================

export function PushToggleButton() {
  const { isPushEnabled, pushPermission, enablePush, disablePush } = usePWA()
  const [isLoading, setIsLoading] = useState(false)

  const handleToggle = async () => {
    setIsLoading(true)
    try {
      if (isPushEnabled) {
        await disablePush()
      } else {
        await enablePush()
      }
    } finally {
      setIsLoading(false)
    }
  }

  if (pushPermission === 'unsupported') {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 bg-zinc-800/50 rounded-lg cursor-not-allowed"
      >
        <BellOff className="w-4 h-4" />
        Não suportado
      </button>
    )
  }

  if (pushPermission === 'denied') {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-2 px-3 py-2 text-xs text-red-400/70 bg-red-500/10 rounded-lg cursor-not-allowed"
        title="Notificações foram bloqueadas. Altere nas configurações do navegador."
      >
        <BellOff className="w-4 h-4" />
        Bloqueadas
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={isLoading}
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg transition-colors',
        isPushEnabled
          ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
          : 'text-zinc-400 bg-zinc-800 hover:bg-zinc-700'
      )}
    >
      {isPushEnabled ? (
        <>
          <Bell className="w-4 h-4" />
          Notificações ativas
        </>
      ) : (
        <>
          <BellOff className="w-4 h-4" />
          Ativar notificações
        </>
      )}
    </button>
  )
}
