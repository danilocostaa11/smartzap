/**
 * Persistência do dismiss do banner "Instalar PWA" (TTL 7 dias).
 */

export const PWA_INSTALL_DISMISS_KEY = 'pwa-install-dismissed'
export const PWA_INSTALL_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function isInstallDismissedActive(
  storedValue: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!storedValue) return false
  const dismissedAt = Number(storedValue)
  if (!Number.isFinite(dismissedAt)) return false
  return nowMs - dismissedAt < PWA_INSTALL_DISMISS_TTL_MS
}
