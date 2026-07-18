import { describe, expect, it } from 'vitest'
import {
  isFinalizationPhraseValid,
  raceFinalizationPhrase,
} from '../shared/finalization'
import { hasRecentPasskeyAuthentication, type SessionState } from '../src/authClient'
import { RealtimeOperationError } from '../src/realtime'

function authenticatedSession(ageMinutes: number): SessionState {
  return {
    mode: 'authenticated',
    user: { id: 'user-a', displayName: '運営 太郎' },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    authenticatedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
  }
}

describe('race finalization guard', () => {
  it('requires the exact race-specific confirmation phrase', () => {
    expect(raceFinalizationPhrase('1R')).toBe('1Rを確定')
    expect(isFinalizationPhraseValid('1R', '1Rを確定')).toBe(true)
    expect(isFinalizationPhraseValid('1R', '2Rを確定')).toBe(false)
    expect(isFinalizationPhraseValid('1R', '1Rを確定 ')).toBe(false)
  })

  it('accepts only a recently authenticated session', () => {
    expect(hasRecentPasskeyAuthentication(authenticatedSession(14))).toBe(true)
    expect(hasRecentPasskeyAuthentication(authenticatedSession(16))).toBe(false)
    expect(hasRecentPasskeyAuthentication({ mode: 'anonymous' })).toBe(false)
  })

  it('provides an actionable message for a server-side reauthentication rejection', () => {
    expect(new RealtimeOperationError('RECENT_AUTHENTICATION_REQUIRED').message)
      .toContain('パスキー')
  })
})
