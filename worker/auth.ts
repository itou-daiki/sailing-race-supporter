import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { AppEnv } from './index.js'
import { json, readJson } from './http.js'
import {
  assertSameOrigin,
  authFlowCookie,
  authFlowId,
  clearAuthFlowCookie,
  clearSessionCookie,
  createSession,
  getSession,
  revokeSession,
} from './security.js'

const RP_NAME = 'Sailing Race Supporter'
const CHALLENGE_DURATION_MS = 10 * 60 * 1_000

interface ChallengeRow {
  id: string
  user_id: string | null
  challenge: string
  rp_id: string
  origin: string
  expires_at: string
}

interface CredentialRow {
  id: string
  user_id: string
  credential_id: string
  public_key: ArrayBuffer
  sign_count: number
  transports_json: string | null
}

function requestContext(request: Request): { rpID: string; origin: string } {
  const url = new URL(request.url)
  return { rpID: url.hostname, origin: url.origin }
}

function responseWithCookies(data: unknown, cookies: string[], status = 200): Response {
  const response = json(data, { status })
  for (const cookie of cookies) response.headers.append('set-cookie', cookie)
  return response
}

async function challenge(
  env: AppEnv,
  flowId: string,
  purpose: 'registration' | 'authentication',
): Promise<ChallengeRow> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, challenge, rp_id, origin, expires_at
     FROM auth_challenges
     WHERE id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
     LIMIT 1`,
  ).bind(flowId, purpose, new Date().toISOString()).first<ChallengeRow>()
  if (!row) throw new Response('Authentication flow expired', { status: 400 })
  return row
}

async function registrationOptions(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const body = await readJson<{ displayName?: string }>(request, 4_096)
  const displayName = body.displayName?.trim()
  if (!displayName || displayName.length < 2 || displayName.length > 80) {
    return json({ error: '名前は2〜80文字で入力してください' }, { status: 400 })
  }

  const { rpID, origin } = requestContext(request)
  const userId = crypto.randomUUID()
  const webauthnUserId = crypto.randomUUID()
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: displayName,
    userDisplayName: displayName,
    userID: Uint8Array.from(new TextEncoder().encode(webauthnUserId)),
    timeout: 120_000,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
  })
  const flowId = crypto.randomUUID()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + CHALLENGE_DURATION_MS).toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, display_name, webauthn_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, displayName, webauthnUserId, now, now),
    env.DB.prepare(
      `INSERT INTO auth_challenges
       (id, user_id, purpose, challenge, display_name, rp_id, origin, expires_at, created_at)
       VALUES (?, ?, 'registration', ?, ?, ?, ?, ?, ?)`,
    ).bind(flowId, userId, options.challenge, displayName, rpID, origin, expiresAt, now),
  ])

  return responseWithCookies({ options }, [authFlowCookie(flowId)])
}

async function registrationVerification(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const flowId = authFlowId(request)
  if (!flowId) return json({ error: '登録手続を最初からやり直してください' }, { status: 400 })
  const stored = await challenge(env, flowId, 'registration')
  if (!stored.user_id) throw new Response('Registration user missing', { status: 400 })
  const body = await readJson<{ response?: RegistrationResponseJSON }>(request)
  if (!body.response) return json({ error: 'パスキー応答がありません' }, { status: 400 })

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: stored.challenge,
    expectedOrigin: stored.origin,
    expectedRPID: stored.rp_id,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  })
  if (!verification.verified) return json({ error: 'パスキーを検証できませんでした' }, { status: 400 })

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO passkey_credentials
       (id, user_id, credential_id, public_key, sign_count, transports_json, device_type, backed_up, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      stored.user_id,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
      now,
    ),
    env.DB.prepare(
      'UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    ).bind(now, flowId),
  ])
  const created = await createSession(request, env, stored.user_id)
  return responseWithCookies(
    {
      verified: true,
      user: { id: created.session.userId, displayName: created.session.displayName },
      expiresAt: created.session.expiresAt,
      authenticatedAt: created.session.createdAt,
    },
    [created.cookie, clearAuthFlowCookie()],
  )
}

async function authenticationOptions(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const { rpID, origin } = requestContext(request)
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 120_000,
    userVerification: 'required',
  })
  const flowId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO auth_challenges
     (id, purpose, challenge, rp_id, origin, expires_at, created_at)
     VALUES (?, 'authentication', ?, ?, ?, ?, ?)`,
  ).bind(
    flowId,
    options.challenge,
    rpID,
    origin,
    new Date(Date.now() + CHALLENGE_DURATION_MS).toISOString(),
    now,
  ).run()
  return responseWithCookies({ options }, [authFlowCookie(flowId)])
}

async function authenticationVerification(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const flowId = authFlowId(request)
  if (!flowId) return json({ error: '認証手続を最初からやり直してください' }, { status: 400 })
  const stored = await challenge(env, flowId, 'authentication')
  const body = await readJson<{ response?: AuthenticationResponseJSON }>(request)
  if (!body.response) return json({ error: 'パスキー応答がありません' }, { status: 400 })

  const credential = await env.DB.prepare(
    `SELECT id, user_id, credential_id, public_key, sign_count, transports_json
     FROM passkey_credentials WHERE credential_id = ? LIMIT 1`,
  ).bind(body.response.id).first<CredentialRow>()
  if (!credential) return json({ error: 'このパスキーは登録されていません' }, { status: 404 })

  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: stored.challenge,
    expectedOrigin: stored.origin,
    expectedRPID: stored.rp_id,
    credential: {
      id: credential.credential_id,
      publicKey: new Uint8Array(credential.public_key),
      counter: credential.sign_count,
      transports: credential.transports_json
        ? JSON.parse(credential.transports_json) as AuthenticatorTransportFuture[]
        : undefined,
    },
    requireUserVerification: true,
  })
  if (!verification.verified) return json({ error: 'パスキーを検証できませんでした' }, { status: 401 })

  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE passkey_credentials
       SET sign_count = ?, backed_up = ?, last_used_at = ?
       WHERE id = ?`,
    ).bind(
      verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      now,
      credential.id,
    ),
    env.DB.prepare(
      'UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    ).bind(now, flowId),
  ])
  await revokeSession(request, env)
  const created = await createSession(request, env, credential.user_id)
  return responseWithCookies(
    {
      verified: true,
      user: { id: created.session.userId, displayName: created.session.displayName },
      expiresAt: created.session.expiresAt,
      authenticatedAt: created.session.createdAt,
    },
    [created.cookie, clearAuthFlowCookie()],
  )
}

export async function handleAuthRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith('/api/auth/')) return null

  if (request.method === 'POST' && pathname === '/api/auth/registration/options') {
    return registrationOptions(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/registration/verify') {
    return registrationVerification(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/authentication/options') {
    return authenticationOptions(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/authentication/verify') {
    return authenticationVerification(request, env)
  }
  if (request.method === 'GET' && pathname === '/api/auth/session') {
    const session = await getSession(request, env)
    return json(session
      ? {
          authenticated: true,
          user: { id: session.userId, displayName: session.displayName },
          expiresAt: session.expiresAt,
          authenticatedAt: session.createdAt,
        }
      : { authenticated: false })
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    assertSameOrigin(request)
    await revokeSession(request, env)
    return responseWithCookies({ authenticated: false }, [clearSessionCookie()])
  }
  return json({ error: 'Not found' }, { status: 404 })
}
