import { describe, it, expect } from 'vitest'
import {
  attemptTimeoutMs,
  canStartAttempt,
  LONG_ATTEMPT_MIN_BUDGET_MS,
  SHORT_ATTEMPT_MIN_BUDGET_MS,
  SHORT_ATTEMPT_TIMEOUT_MS,
} from './attempt-budget'

const now = 1_000_000
const deadlineAt = now + 260_000 // maxDuration 300s - 40s de margem

describe('attemptTimeoutMs', () => {
  it('curta: teto de 90s', () => {
    expect(attemptTimeoutMs({ longRunning: false, deadlineAt, now })).toBe(SHORT_ATTEMPT_TIMEOUT_MS)
  })
  it('curta: limitada ao que resta do deadline', () => {
    expect(attemptTimeoutMs({ longRunning: false, deadlineAt, now: deadlineAt - 30_000 })).toBe(30_000)
  })
  it('longa: usa todo o tempo restante (cabe uma resposta High de 144s+)', () => {
    expect(attemptTimeoutMs({ longRunning: true, deadlineAt, now })).toBe(260_000)
  })
  it('nunca devolve valor <= 0', () => {
    expect(attemptTimeoutMs({ longRunning: true, deadlineAt, now: deadlineAt + 10 })).toBe(1_000)
  })
})

describe('canStartAttempt', () => {
  it('longa que estourou o timeout nunca reinicia', () => {
    expect(canStartAttempt({ longRunning: true, deadlineAt, now, previousTimedOut: true })).toBe(false)
  })
  it('longa: erro rápido repete se sobrar o mínimo de tentativa longa', () => {
    expect(canStartAttempt({ longRunning: true, deadlineAt, now, delayMs: 1_000 })).toBe(true)
    expect(
      canStartAttempt({ longRunning: true, deadlineAt, now: deadlineAt - LONG_ATTEMPT_MIN_BUDGET_MS, delayMs: 1_000 })
    ).toBe(false)
  })
  it('curta: timeout pode repetir se couber o mínimo curto (comportamento anterior)', () => {
    expect(canStartAttempt({ longRunning: false, deadlineAt, now, delayMs: 1_000, previousTimedOut: true })).toBe(true)
    expect(
      canStartAttempt({ longRunning: false, deadlineAt, now: deadlineAt - SHORT_ATTEMPT_MIN_BUDGET_MS, delayMs: 1_000 })
    ).toBe(false)
  })
})
