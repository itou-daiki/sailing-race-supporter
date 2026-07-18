import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

export interface AuthenticatedUser {
  id: string
  displayName: string
}

export interface AuthenticatedSessionState {
  mode: 'authenticated'
  user: AuthenticatedUser
  expiresAt: string
  authenticatedAt: string
}

export interface AuthSecuritySummary {
  credentialCount: number
  backedUpCredentialCount: number
  resilientForEventCreation: boolean
}

export interface OwnerRecoveryKit {
  recoveryId: string
  eventId: string
  eventSlug: string
  eventName: string
  ownerUserId: string
  issuedAt: string
  recoveryCode: string
}

export type SessionState =
  | { mode: 'checking' }
  | { mode: 'offline-demo' }
  | { mode: 'anonymous' }
  | AuthenticatedSessionState

class AuthApiError extends Error {
  constructor(message: string, readonly unavailable = false) {
    super(message)
  }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new AuthApiError('認証サーバーへ接続できません', true)
  }
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new AuthApiError('Cloudflare Workers認証はまだ接続されていません', true)
  }
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new AuthApiError(body.error ?? '認証処理に失敗しました')
  return body
}

export async function loadSession(): Promise<SessionState> {
  try {
    const result = await apiJson<{
      authenticated: boolean
      user?: AuthenticatedUser
      expiresAt?: string
      authenticatedAt?: string
    }>('/api/auth/session', { method: 'GET', headers: {} })
    return result.authenticated && result.user && result.expiresAt && result.authenticatedAt
      ? { mode: 'authenticated', user: result.user, expiresAt: result.expiresAt, authenticatedAt: result.authenticatedAt }
      : { mode: 'anonymous' }
  } catch (error) {
    if (error instanceof AuthApiError && error.unavailable) return { mode: 'offline-demo' }
    throw error
  }
}

export async function registerPasskey(displayName: string): Promise<AuthenticatedSessionState> {
  const generated = await apiJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/registration/options',
    { method: 'POST', body: JSON.stringify({ displayName }) },
  )
  const { startRegistration } = await import('@simplewebauthn/browser')
  const response = await startRegistration({ optionsJSON: generated.options })
  const verified = await apiJson<{
    verified: boolean
    user: AuthenticatedUser
    expiresAt: string
    authenticatedAt: string
  }>('/api/auth/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  })
  return { mode: 'authenticated', user: verified.user, expiresAt: verified.expiresAt, authenticatedAt: verified.authenticatedAt }
}

export async function registerAdditionalPasskey(): Promise<AuthenticatedSessionState> {
  const generated = await apiJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/passkeys/registration/options',
    { method: 'POST', body: '{}' },
  )
  const { startRegistration } = await import('@simplewebauthn/browser')
  const response = await startRegistration({ optionsJSON: generated.options })
  const verified = await apiJson<{
    verified: boolean
    user: AuthenticatedUser
    expiresAt: string
    authenticatedAt: string
  }>('/api/auth/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  })
  return { mode: 'authenticated', user: verified.user, expiresAt: verified.expiresAt, authenticatedAt: verified.authenticatedAt }
}

export async function loadAuthSecurity(): Promise<AuthSecuritySummary> {
  return apiJson<AuthSecuritySummary>('/api/auth/security', { method: 'GET', headers: {} })
}

export async function recoverOwnerAccount(eventReference: string, recoveryCode: string): Promise<{
  session: AuthenticatedSessionState
  event: { id: string; slug: string; name: string }
  ownerRecoveryKit: OwnerRecoveryKit
}> {
  const generated = await apiJson<{
    options: PublicKeyCredentialCreationOptionsJSON
    event: { id: string; slug: string; name: string }
  }>('/api/auth/owner-recovery/options', {
    method: 'POST',
    body: JSON.stringify({ eventReference, recoveryCode }),
  })
  const { startRegistration } = await import('@simplewebauthn/browser')
  const response = await startRegistration({ optionsJSON: generated.options })
  const verified = await apiJson<{
    verified: boolean
    user: AuthenticatedUser
    expiresAt: string
    authenticatedAt: string
    event: { id: string; slug: string; name: string }
    ownerRecoveryKit: OwnerRecoveryKit
  }>('/api/auth/owner-recovery/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  })
  return {
    session: {
      mode: 'authenticated',
      user: verified.user,
      expiresAt: verified.expiresAt,
      authenticatedAt: verified.authenticatedAt,
    },
    event: verified.event,
    ownerRecoveryKit: verified.ownerRecoveryKit,
  }
}

export async function authenticatePasskey(): Promise<AuthenticatedSessionState> {
  const generated = await apiJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    '/api/auth/authentication/options',
    { method: 'POST', body: '{}' },
  )
  const { startAuthentication } = await import('@simplewebauthn/browser')
  const response = await startAuthentication({ optionsJSON: generated.options })
  const verified = await apiJson<{
    verified: boolean
    user: AuthenticatedUser
    expiresAt: string
    authenticatedAt: string
  }>('/api/auth/authentication/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  })
  return { mode: 'authenticated', user: verified.user, expiresAt: verified.expiresAt, authenticatedAt: verified.authenticatedAt }
}

export function hasRecentPasskeyAuthentication(session: SessionState, maximumAgeMinutes = 15): boolean {
  if (session.mode !== 'authenticated') return false
  const authenticatedAt = Date.parse(session.authenticatedAt)
  return Number.isFinite(authenticatedAt) && Date.now() - authenticatedAt <= maximumAgeMinutes * 60_000
}

export async function logout(): Promise<void> {
  await apiJson('/api/auth/logout', { method: 'POST', body: '{}' })
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'パスキー操作がキャンセルされたか、時間切れになりました'
  }
  return error instanceof Error ? error.message : '認証処理に失敗しました'
}
