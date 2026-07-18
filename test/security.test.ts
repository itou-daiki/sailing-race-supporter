import { describe, expect, it } from 'vitest'
import { can, type EventAccess } from '../worker/authorization'
import {
  assertSameOrigin,
  hasRecentAuthentication,
  randomToken,
  sha256Base64Url,
  shouldRefreshSessionLastSeen,
} from '../worker/security'

function access(role: string, isOwner = false): EventAccess {
  return {
    eventId: 'event-a',
    eventSlug: 'event-a',
    eventName: 'テスト大会',
    userId: 'user-a',
    memberId: isOwner ? 'owner:user-a' : 'member-a',
    displayName: '運営 太郎',
    role,
    assignment: '1マーク',
    isOwner,
  }
}

describe('authorization', () => {
  it('allows an owner to finalize and create a post-finalization revision', () => {
    expect(can(access('owner', true), 'finalize')).toBe(true)
    expect(can(access('owner', true), 'post-finalization-revision')).toBe(true)
  })

  it('limits mark boats to their operational permissions', () => {
    const markBoat = access('マークボート')
    expect(can(markBoat, 'position')).toBe(true)
    expect(can(markBoat, 'mark')).toBe(true)
    expect(can(markBoat, 'message')).toBe(true)
    expect(can(markBoat, 'signal')).toBe(false)
    expect(can(markBoat, 'finalize')).toBe(false)
    expect(can(markBoat, 'finish')).toBe(false)
  })

  it('allows finish timing only for race committee recording roles', () => {
    expect(can(access('timekeeper'), 'finish')).toBe(true)
    expect(can(access('record-keeper'), 'finish')).toBe(true)
    expect(can(access('signal-boat'), 'finish')).toBe(true)
    expect(can(access('viewer'), 'finish')).toBe(false)
  })

  it('keeps viewers read-only', () => {
    const viewer = access('viewer')
    expect(can(viewer, 'view')).toBe(true)
    expect(can(viewer, 'position')).toBe(false)
    expect(can(viewer, 'message')).toBe(false)
  })
})

describe('request security', () => {
  it('rejects a state-changing cross-origin request', () => {
    const request = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://attacker.invalid' },
    })
    expect(() => assertSameOrigin(request)).toThrow(Response)
  })

  it('accepts a same-origin request and creates non-repeating tokens', () => {
    const request = new Request('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://example.com' },
    })
    expect(() => assertSameOrigin(request)).not.toThrow()
    expect(randomToken()).not.toBe(randomToken())
  })

  it('hashes a value deterministically without retaining the source', async () => {
    const first = await sha256Base64Url('recovery-secret')
    const second = await sha256Base64Url('recovery-secret')
    expect(first).toBe(second)
    expect(first).not.toContain('recovery-secret')
  })

  it('requires a newly authenticated session for destructive retention operations', () => {
    const base = { tokenHash: 'token', userId: 'user-a', displayName: '管理者', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    expect(hasRecentAuthentication({ ...base, createdAt: new Date(Date.now() - 14 * 60_000).toISOString() })).toBe(true)
    expect(hasRecentAuthentication({ ...base, createdAt: new Date(Date.now() - 16 * 60_000).toISOString() })).toBe(false)
  })

  it('limits session activity writes to once every five minutes', () => {
    const now = '2026-07-18T08:05:00.000Z'
    expect(shouldRefreshSessionLastSeen('2026-07-18T08:00:01.000Z', now)).toBe(false)
    expect(shouldRefreshSessionLastSeen('2026-07-18T08:00:00.000Z', now)).toBe(true)
    expect(shouldRefreshSessionLastSeen('invalid', now)).toBe(true)
  })
})
