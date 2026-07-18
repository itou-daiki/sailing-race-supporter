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
import { generateOwnerRecoveryCode, isOwnerRecoveryCode, normalizeOwnerRecoveryCode } from '../shared/ownerRecovery.js'
import { appendAuditEventWithoutBlockingSecretDelivery } from './audit.js'
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
  hasRecentAuthentication,
  requireSession,
  revokeSession,
  sha256Base64Url,
} from './security.js'

const RP_NAME = 'Sailing Race Supporter'
const CHALLENGE_DURATION_MS = 10 * 60 * 1_000
const OWNER_RECOVERY_RATE_WINDOW_MS = 15 * 60 * 1_000
const OWNER_RECOVERY_REFERENCE_FAILURE_LIMIT = 5
const OWNER_RECOVERY_NETWORK_FAILURE_LIMIT = 20
const OWNER_RECOVERY_REFERENCE_ATTEMPT_LIMIT = 10
const OWNER_RECOVERY_NETWORK_ATTEMPT_LIMIT = 50

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

interface RegistrationUserRow {
  id: string
  display_name: string
  webauthn_user_id: string
}

interface OwnerRecoveryFlowRow {
  recovery_id: string
  regatta_id: string
  event_slug: string
  event_name: string
  owner_user_id: string
  display_name: string
  webauthn_user_id: string
  member_id: string | null
  confirmed_at: string | null
  used_at: string | null
  revoked_at: string | null
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

async function credentialDescriptors(env: AppEnv, userId: string): Promise<Array<{
  id: string
  transports?: AuthenticatorTransportFuture[]
}>> {
  const credentials = await env.DB.prepare(
    `SELECT credential_id, transports_json
     FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(userId).all<{ credential_id: string; transports_json: string | null }>()
  return credentials.results.flatMap((credential) => {
    const id = credential.credential_id
    if (!id || !/^[A-Za-z0-9_-]+$/u.test(id) || id.length % 4 === 1) return []
    let transports: AuthenticatorTransportFuture[] | undefined
    try {
      const parsed = credential.transports_json ? JSON.parse(credential.transports_json) as unknown : undefined
      if (Array.isArray(parsed)) transports = parsed.filter((value): value is AuthenticatorTransportFuture => typeof value === 'string')
    } catch {
      transports = undefined
    }
    return [{ id, transports }]
  })
}

async function registrationOptionsForUser(
  request: Request,
  env: AppEnv,
  user: RegistrationUserRow,
): Promise<Response> {
  const { rpID, origin } = requestContext(request)
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.display_name,
    userDisplayName: user.display_name,
    userID: Uint8Array.from(new TextEncoder().encode(user.webauthn_user_id)),
    timeout: 120_000,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: await credentialDescriptors(env, user.id),
  })
  const flowId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO auth_challenges
     (id, user_id, purpose, challenge, display_name, rp_id, origin, expires_at, created_at)
     VALUES (?, ?, 'registration', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    flowId,
    user.id,
    options.challenge,
    user.display_name,
    rpID,
    origin,
    new Date(Date.now() + CHALLENGE_DURATION_MS).toISOString(),
    now,
  ).run()
  return responseWithCookies({ options }, [authFlowCookie(flowId)])
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

async function additionalRegistrationOptions(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  if (!hasRecentAuthentication(session)) {
    return json({
      error: '予備パスキーの追加には、直前15分以内のパスキー認証が必要です',
      code: 'REAUTHENTICATION_REQUIRED',
    }, { status: 428 })
  }
  const user = await env.DB.prepare(
    `SELECT id, display_name, webauthn_user_id FROM users WHERE id = ? LIMIT 1`,
  ).bind(session.userId).first<RegistrationUserRow>()
  if (!user?.webauthn_user_id) return json({ error: 'パスキー利用者情報が見つかりません' }, { status: 404 })
  return registrationOptionsForUser(request, env, user)
}

async function registrationVerification(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const flowId = authFlowId(request)
  if (!flowId) return json({ error: '登録手続を最初からやり直してください' }, { status: 400 })
  const stored = await challenge(env, flowId, 'registration')
  if (!stored.user_id) throw new Response('Registration user missing', { status: 400 })
  const existingCredentials = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL',
  ).bind(stored.user_id).first<{ count: number }>()
  if ((existingCredentials?.count ?? 0) > 0) {
    const session = await getSession(request, env)
    if (!session || session.userId !== stored.user_id || !hasRecentAuthentication(session)) {
      return json({
        error: '予備パスキーの追加には、同じアカウントでの直前15分以内の認証が必要です',
        code: 'REAUTHENTICATION_REQUIRED',
      }, { status: 428 })
    }
  }
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
     FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL LIMIT 1`,
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

async function securitySummary(request: Request, env: AppEnv): Promise<Response> {
  const session = await requireSession(request, env)
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN backed_up = 1 THEN 1 ELSE 0 END) AS backed_up_count
     FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(session.userId).first<{ count: number; backed_up_count: number | null }>()
  return json({
    credentialCount: result?.count ?? 0,
    backedUpCredentialCount: result?.backed_up_count ?? 0,
    resilientForEventCreation: (result?.count ?? 0) >= 2,
  })
}

function ownerRecoveryUnavailable(): Response {
  return json({ error: '大会URLまたはオーナー復旧コードを確認できません' }, { status: 404 })
}

async function ownerRecoveryRateContext(
  request: Request,
  env: AppEnv,
  eventReference: string,
): Promise<{
  eventReferenceHash: string
  networkHash: string
  regattaId: string | null
  limited: boolean
}> {
  const eventReferenceHash = await sha256Base64Url(eventReference.toLowerCase())
  const networkHash = await sha256Base64Url(request.headers.get('cf-connecting-ip') ?? 'local')
  const since = new Date(Date.now() - OWNER_RECOVERY_RATE_WINDOW_MS).toISOString()
  const [event, failures] = await Promise.all([
    env.DB.prepare('SELECT id FROM regattas WHERE id = ? OR slug = ? LIMIT 1')
      .bind(eventReference, eventReference).first<{ id: string }>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN event_reference_hash = ? AND success = 0 THEN 1 ELSE 0 END) AS reference_failures,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS network_failures,
         SUM(CASE WHEN event_reference_hash = ? THEN 1 ELSE 0 END) AS reference_attempts,
         COUNT(*) AS network_attempts
       FROM owner_recovery_attempts
       WHERE network_hash = ? AND attempted_at >= ?`,
    ).bind(eventReferenceHash, eventReferenceHash, networkHash, since).first<{
      reference_failures: number | null
      network_failures: number | null
      reference_attempts: number | null
      network_attempts: number
    }>(),
  ])
  return {
    eventReferenceHash,
    networkHash,
    regattaId: event?.id ?? null,
    limited: (failures?.reference_failures ?? 0) >= OWNER_RECOVERY_REFERENCE_FAILURE_LIMIT
      || (failures?.network_failures ?? 0) >= OWNER_RECOVERY_NETWORK_FAILURE_LIMIT
      || (failures?.reference_attempts ?? 0) >= OWNER_RECOVERY_REFERENCE_ATTEMPT_LIMIT
      || (failures?.network_attempts ?? 0) >= OWNER_RECOVERY_NETWORK_ATTEMPT_LIMIT,
  }
}

async function recordOwnerRecoveryAttempt(
  env: AppEnv,
  context: Awaited<ReturnType<typeof ownerRecoveryRateContext>>,
  success: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO owner_recovery_attempts
     (id, event_reference_hash, regatta_id, attempted_at, success, network_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    context.eventReferenceHash,
    context.regattaId,
    new Date().toISOString(),
    success ? 1 : 0,
    context.networkHash,
  ).run()
}

async function ownerRecoveryOptions(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const body = await readJson<{ eventReference?: string; recoveryCode?: string }>(request, 8_192)
  const eventReference = body.eventReference?.trim() ?? ''
  const recoveryCode = body.recoveryCode?.trim() ?? ''
  if (!eventReference || eventReference.length > 120) return ownerRecoveryUnavailable()
  const rateContext = await ownerRecoveryRateContext(request, env, eventReference)
  if (rateContext.limited) {
    return json(
      { error: '試行回数が多すぎます。15分後に再試行してください' },
      { status: 429, headers: { 'retry-after': '900' } },
    )
  }
  if (!isOwnerRecoveryCode(recoveryCode)) {
    await recordOwnerRecoveryAttempt(env, rateContext, false)
    return ownerRecoveryUnavailable()
  }
  const secretHash = await sha256Base64Url(normalizeOwnerRecoveryCode(recoveryCode))
  const row = await env.DB.prepare(
    `SELECT credential.id AS recovery_id, regatta.id AS regatta_id,
            regatta.slug AS event_slug, regatta.name AS event_name,
            credential.owner_user_id, user.display_name, user.webauthn_user_id, member.id AS member_id,
            credential.confirmed_at, credential.used_at, credential.revoked_at
     FROM owner_recovery_credentials credential
     JOIN regattas regatta ON regatta.id = credential.regatta_id
     JOIN users user ON user.id = credential.owner_user_id
     LEFT JOIN event_members member
       ON member.regatta_id = regatta.id AND member.user_id = credential.owner_user_id
     WHERE regatta.id = ? AND credential.secret_hash = ?
     ORDER BY credential.created_at DESC LIMIT 1`,
  ).bind(rateContext.regattaId ?? '', secretHash).first<OwnerRecoveryFlowRow>()
  if (!row || !row.confirmed_at || row.used_at || row.revoked_at) {
    await recordOwnerRecoveryAttempt(env, rateContext, false)
    return ownerRecoveryUnavailable()
  }
  await recordOwnerRecoveryAttempt(env, rateContext, true)

  const { rpID, origin } = requestContext(request)
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: row.display_name,
    userDisplayName: row.display_name,
    userID: Uint8Array.from(new TextEncoder().encode(row.webauthn_user_id)),
    timeout: 120_000,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: await credentialDescriptors(env, row.owner_user_id),
  })
  const flowId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO auth_challenges
       (id, user_id, purpose, challenge, display_name, rp_id, origin, expires_at, created_at)
       VALUES (?, ?, 'registration', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      flowId,
      row.owner_user_id,
      options.challenge,
      row.display_name,
      rpID,
      origin,
      new Date(Date.now() + CHALLENGE_DURATION_MS).toISOString(),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO owner_recovery_flows
       (auth_challenge_id, recovery_credential_id, regatta_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(flowId, row.recovery_id, row.regatta_id, now),
  ])
  return responseWithCookies({
    options,
    event: { id: row.regatta_id, slug: row.event_slug, name: row.event_name },
  }, [authFlowCookie(flowId)])
}

async function ownerRecoveryVerification(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const flowId = authFlowId(request)
  if (!flowId) return json({ error: 'オーナー復旧を最初からやり直してください' }, { status: 400 })
  const stored = await challenge(env, flowId, 'registration')
  const flow = await env.DB.prepare(
    `SELECT credential.id AS recovery_id, regatta.id AS regatta_id,
            regatta.slug AS event_slug, regatta.name AS event_name,
            credential.owner_user_id, user.display_name, user.webauthn_user_id, member.id AS member_id,
            credential.confirmed_at, credential.used_at, credential.revoked_at
     FROM owner_recovery_flows flow
     JOIN owner_recovery_credentials credential ON credential.id = flow.recovery_credential_id
     JOIN regattas regatta ON regatta.id = flow.regatta_id
     JOIN users user ON user.id = credential.owner_user_id
     LEFT JOIN event_members member
       ON member.regatta_id = regatta.id AND member.user_id = credential.owner_user_id
     WHERE flow.auth_challenge_id = ? LIMIT 1`,
  ).bind(flowId).first<OwnerRecoveryFlowRow>()
  if (!flow || !flow.confirmed_at || flow.used_at || flow.revoked_at || stored.user_id !== flow.owner_user_id) {
    return ownerRecoveryUnavailable()
  }
  const body = await readJson<{ response?: RegistrationResponseJSON }>(request)
  if (!body.response) return json({ error: '新しいパスキーの応答がありません' }, { status: 400 })
  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: stored.challenge,
    expectedOrigin: stored.origin,
    expectedRPID: stored.rp_id,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  })
  if (!verification.verified) return json({ error: '新しいパスキーを検証できませんでした' }, { status: 400 })

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
  const now = new Date().toISOString()
  const newCredentialId = crypto.randomUUID()
  const nextRecoveryId = crypto.randomUUID()
  const nextRecoveryCode = generateOwnerRecoveryCode()
  const nextRecoveryHash = await sha256Base64Url(normalizeOwnerRecoveryCode(nextRecoveryCode))
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE owner_recovery_credentials
       SET used_at = ?, revoked_at = ?, claimed_by_flow_id = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND claimed_by_flow_id IS NULL`,
    ).bind(now, now, flowId, flow.recovery_id),
    env.DB.prepare(
      `UPDATE passkey_credentials SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM owner_recovery_credentials
           WHERE id = ? AND claimed_by_flow_id = ?
         )`,
    ).bind(now, flow.owner_user_id, flow.recovery_id, flowId),
    env.DB.prepare(
      `INSERT INTO passkey_credentials
       (id, user_id, credential_id, public_key, sign_count, transports_json,
        device_type, backed_up, created_at, last_used_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM owner_recovery_credentials
         WHERE id = ? AND claimed_by_flow_id = ?
       )`,
    ).bind(
      newCredentialId,
      flow.owner_user_id,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
      now,
      flow.recovery_id,
      flowId,
    ),
    env.DB.prepare(
      `UPDATE auth_sessions SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM owner_recovery_credentials
           WHERE id = ? AND claimed_by_flow_id = ?
         )`,
    ).bind(now, flow.owner_user_id, flow.recovery_id, flowId),
    env.DB.prepare(
      `INSERT INTO owner_recovery_credentials
       (id, regatta_id, owner_user_id, secret_hash, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM owner_recovery_credentials
         WHERE id = ? AND claimed_by_flow_id = ?
       )`,
    ).bind(
      nextRecoveryId,
      flow.regatta_id,
      flow.owner_user_id,
      nextRecoveryHash,
      now,
      flow.recovery_id,
      flowId,
    ),
    env.DB.prepare(
      `UPDATE owner_recovery_credentials SET replaced_by_id = ?
       WHERE id = ? AND claimed_by_flow_id = ?`,
    ).bind(nextRecoveryId, flow.recovery_id, flowId),
    env.DB.prepare(
      `UPDATE auth_challenges SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM owner_recovery_credentials
           WHERE id = ? AND claimed_by_flow_id = ?
         )`,
    ).bind(now, flowId, flow.recovery_id, flowId),
    env.DB.prepare(
      `DELETE FROM owner_recovery_flows
       WHERE auth_challenge_id = ?
         AND EXISTS (
           SELECT 1 FROM owner_recovery_credentials
           WHERE id = ? AND claimed_by_flow_id = ?
         )`,
    ).bind(flowId, flow.recovery_id, flowId),
  ])
  if (results[2].meta.changes !== 1) {
    return json({ error: 'この復旧コードは別の端末で使用されました' }, { status: 409 })
  }
  const created = await createSession(request, env, flow.owner_user_id)
  const auditRecorded = await appendAuditEventWithoutBlockingSecretDelivery(env, {
    access: {
      eventId: flow.regatta_id,
      eventSlug: flow.event_slug,
      eventName: flow.event_name,
      userId: flow.owner_user_id,
      memberId: flow.member_id ?? `owner:${flow.owner_user_id}`,
      displayName: flow.display_name,
      role: 'owner',
      assignment: '大会管理者',
      isOwner: true,
    },
    action: 'owner-recovery.use',
    entityType: 'owner_recovery_credential',
    entityId: flow.recovery_id,
    before: { oldPasskeysRevoked: true, oldSessionsRevoked: true },
    after: { newCredentialId, nextRecoveryId, nextRecoveryConfirmed: false },
    reason: '一回限りの復旧コードを使用して大会管理者を新端末へ復旧',
  })
  return responseWithCookies({
    verified: true,
    user: { id: created.session.userId, displayName: created.session.displayName },
    expiresAt: created.session.expiresAt,
    authenticatedAt: created.session.createdAt,
    auditRecorded,
    event: { id: flow.regatta_id, slug: flow.event_slug, name: flow.event_name },
    ownerRecoveryKit: {
      recoveryId: nextRecoveryId,
      eventId: flow.regatta_id,
      eventSlug: flow.event_slug,
      eventName: flow.event_name,
      ownerUserId: flow.owner_user_id,
      issuedAt: now,
      recoveryCode: nextRecoveryCode,
    },
  }, [created.cookie, clearAuthFlowCookie()])
}

export async function handleAuthRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith('/api/auth/')) return null

  if (request.method === 'POST' && pathname === '/api/auth/registration/options') {
    return registrationOptions(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/passkeys/registration/options') {
    return additionalRegistrationOptions(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/registration/verify') {
    return registrationVerification(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/owner-recovery/options') {
    return ownerRecoveryOptions(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/owner-recovery/verify') {
    return ownerRecoveryVerification(request, env)
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
  if (request.method === 'GET' && pathname === '/api/auth/security') {
    return securitySummary(request, env)
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    assertSameOrigin(request)
    await revokeSession(request, env)
    return responseWithCookies({ authenticated: false }, [clearSessionCookie()])
  }
  return json({ error: 'Not found' }, { status: 404 })
}
