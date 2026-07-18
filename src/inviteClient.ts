import type { SessionState } from './authClient'

export interface InvitePreview {
  event: { slug: string; name: string }
  invite: { id: string; role: string; assignment: string; expiresAt: string | null }
}

export interface InviteResult {
  authenticated: true
  user: { id: string; displayName: string }
  expiresAt: string
  authenticatedAt: string
  event: { slug: string; name: string }
  member: { id: string; displayName: string; role: string; assignment: string }
  recovery: { issuedAt: string; expiresAt: string }
}

export interface InviteRecord {
  id: string
  role: string
  assignment: string
  committee_boat_id: string | null
  mark_id: string | null
  max_uses: number | null
  use_count: number
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface CreateInviteInput {
  role: string
  assignment: string
  committeeBoatId?: string
  markId?: string
  maxUses?: number | null
  expiresAt?: string | null
}

class InviteApiError extends Error {}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) throw new InviteApiError('招待サーバーへ接続できません')
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new InviteApiError(body.error ?? `招待APIエラー (${response.status})`)
  return body
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function newRecoverySecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)))
}

export function sessionFromInvite(result: InviteResult): SessionState {
  return {
    mode: 'authenticated',
    user: result.user,
    expiresAt: result.expiresAt,
    authenticatedAt: result.authenticatedAt,
  }
}

export async function previewInvite(inviteId: string, secret: string): Promise<InvitePreview> {
  return apiJson(`/api/invites/${encodeURIComponent(inviteId)}/preview`, {
    method: 'POST',
    body: JSON.stringify({ secret }),
  })
}

export async function exchangeInvite(
  inviteId: string,
  secret: string,
  displayName: string,
  recoverySecret: string,
): Promise<InviteResult> {
  return apiJson(`/api/invites/${encodeURIComponent(inviteId)}/exchange`, {
    method: 'POST',
    body: JSON.stringify({ secret, displayName, recoverySecret }),
  })
}

export async function recoverMember(
  eventSlug: string,
  memberId: string,
  recoverySecret: string,
  replacementSecret: string,
): Promise<InviteResult> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/recover`, {
    method: 'POST',
    body: JSON.stringify({ memberId, recoverySecret, newRecoverySecret: replacementSecret }),
  })
}

export async function createInvite(
  eventSlug: string,
  input: CreateInviteInput,
): Promise<{ invite: InviteRecord; url: string }> {
  const created = await apiJson<{
    invite: { id: string; role: string; assignment: string; maxUses: number | null; useCount: number; expiresAt: string | null }
    url: string
  }>(`/api/events/${encodeURIComponent(eventSlug)}/invites`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return {
    url: created.url,
    invite: {
      id: created.invite.id,
      role: created.invite.role,
      assignment: created.invite.assignment,
      committee_boat_id: input.committeeBoatId ?? null,
      mark_id: input.markId ?? null,
      max_uses: created.invite.maxUses,
      use_count: created.invite.useCount,
      expires_at: created.invite.expiresAt,
      revoked_at: null,
      created_at: new Date().toISOString(),
    },
  }
}

export async function listInvites(eventSlug: string): Promise<InviteRecord[]> {
  return (await apiJson<{ invites: InviteRecord[] }>(
    `/api/events/${encodeURIComponent(eventSlug)}/invites`,
    { method: 'GET', headers: {} },
  )).invites
}

export async function revokeInvite(eventSlug: string, inviteId: string): Promise<void> {
  await apiJson(`/api/events/${encodeURIComponent(eventSlug)}/invites/${encodeURIComponent(inviteId)}/revoke`, {
    method: 'POST',
    body: '{}',
  })
}
