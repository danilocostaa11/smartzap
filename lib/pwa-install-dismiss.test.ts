import { describe, expect, it } from 'vitest'
import {
  isInstallDismissedActive,
  PWA_INSTALL_DISMISS_TTL_MS,
} from './pwa-install-dismiss'

describe('isInstallDismissedActive', () => {
  it('returns false when nothing stored', () => {
    expect(isInstallDismissedActive(null)).toBe(false)
  })

  it('returns false for invalid values', () => {
    expect(isInstallDismissedActive('abc')).toBe(false)
  })

  it('returns true within 7 days', () => {
    const now = 1_700_000_000_000
    const stored = String(now - 24 * 60 * 60 * 1000)
    expect(isInstallDismissedActive(stored, now)).toBe(true)
  })

  it('returns false after TTL expires', () => {
    const now = 1_700_000_000_000
    const stored = String(now - PWA_INSTALL_DISMISS_TTL_MS - 1)
    expect(isInstallDismissedActive(stored, now)).toBe(false)
  })
})
