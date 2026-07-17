import type { AppEnv } from './index.js'

const SESSION_COOKIE = 'srs_session'
const SESSION_DURATION_MS = 12 * 60 * 60 * 1_000

export interface AuthenticatedSession {
  tokenHash: string
  userId: string
  displayName: string
  expiresAt: string
}

interface SessionRow {
  token_hash: string
  user_id: string
  display_name: string
  expires_at: string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64Url(new Uint8Array(digest))
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

function cookies(request: Request): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    parsed.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()))
  }
  return parsed
}

export function authFlowCookie(flowId: string, maxAgeSeconds = 600): string {
  return `srs_auth_flow=${encodeURIComponent(flowId)}; Path=/api/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export function clearAuthFlowCookie(): string {
  return 'srs_auth_flow=; Path=/api/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
}

export function authFlowId(request: Request): string | undefined {
  return cookies(request).get('srs_auth_flow')
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export function assertSameOrigin(request: Request): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
  const origin = request.headers.get('origin')
  const expected = new URL(request.url).origin
  if (origin !== expected) throw new Response('Invalid request origin', { status: 403 })
}

export async function createSession(
  request: Request,
  env: AppEnv,
  userId: string,
): Promise<{ session: AuthenticatedSession; cookie: string }> {
  const rawToken = randomToken(32)
  const tokenHash = await sha256Base64Url(rawToken)
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString()
  const userAgentHash = await sha256Base64Url(request.headers.get('user-agent') ?? '')
  const user = await env.DB.prepare(
    'SELECT display_name FROM users WHERE id = ? LIMIT 1',
  ).bind(userId).first<{ display_name: string }>()
  if (!user) throw new Response('User not found', { status: 404 })

  await env.DB.prepare(
    `INSERT INTO auth_sessions
     (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(tokenHash, userId, createdAt, expiresAt, createdAt, userAgentHash).run()

  return {
    session: { tokenHash, userId, displayName: user.display_name, expiresAt },
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_DURATION_MS / 1_000)}`,
  }
}

export async function getSession(request: Request, env: AppEnv): Promise<AuthenticatedSession | null> {
  const rawToken = cookies(request).get(SESSION_COOKIE)
  if (!rawToken) return null
  const tokenHash = await sha256Base64Url(rawToken)
  const now = new Date().toISOString()
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.user_id, s.expires_at, u.display_name
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
     LIMIT 1`,
  ).bind(tokenHash, now).first<SessionRow>()
  if (!row) return null

  void env.DB.prepare(
    'UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?',
  ).bind(now, tokenHash).run()
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    displayName: row.display_name,
    expiresAt: row.expires_at,
  }
}

export async function requireSession(request: Request, env: AppEnv): Promise<AuthenticatedSession> {
  const session = await getSession(request, env)
  if (!session) throw new Response('Authentication required', { status: 401 })
  return session
}

export async function revokeSession(request: Request, env: AppEnv): Promise<void> {
  const session = await getSession(request, env)
  if (!session) return
  await env.DB.prepare(
    'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?',
  ).bind(new Date().toISOString(), session.tokenHash).run()
}
