import { eventAccess, type EventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import {
  assertSameOrigin,
  createSession,
  getSession,
  randomToken,
  requireSession,
  sha256Base64Url,
} from './security.js'

const INVITE_ROLES = new Set([
  'pro', 'ro', 'course-setter', 'signal-boat', 'mark-boat', 'safety-boat', 'jury', 'protest', 'viewer',
])
const PRIVILEGED_RECOVERY_ROLES = new Set(['owner', 'pro', 'ro'])

interface InviteRow {
  id: string
  regatta_id: string
  event_slug: string
  event_name: string
  ends_on: string
  role: string
  assignment_scope_json: string
  race_area_id: string | null
  committee_boat_id: string | null
  mark_id: string | null
  max_uses: number | null
  use_count: number
  expires_at: string | null
  revoked_at: string | null
}

interface RecoveryRow {
  credential_id: string
  event_member_id: string
  regatta_id: string
  event_slug: string
  event_name: string
  user_id: string
  display_name: string
  role: string
  assignment: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
  member_status: string
}

function stringValue(value: unknown, field: string, maxLength = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Response(`Invalid ${field}`, { status: 400 })
  }
  return value.trim()
}

function responseWithCookie(data: unknown, cookie: string, status = 200): Response {
  const response = json(data, { status })
  response.headers.append('set-cookie', cookie)
  return response
}

function assignment(invite: InviteRow): string {
  try {
    const scope = JSON.parse(invite.assignment_scope_json) as { assignment?: unknown }
    return typeof scope.assignment === 'string' ? scope.assignment : invite.role
  } catch {
    return invite.role
  }
}

function assertInviteActive(invite: InviteRow): void {
  if (invite.revoked_at) throw new Response('この招待URLは失効しています', { status: 410 })
  if (invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) {
    throw new Response('この招待URLは期限切れです', { status: 410 })
  }
  if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
    throw new Response('この招待URLは使用上限に達しました', { status: 410 })
  }
}

async function inviteBySecret(env: AppEnv, inviteId: string, secret: string): Promise<InviteRow> {
  const tokenHash = await sha256Base64Url(secret)
  const invite = await env.DB.prepare(
    `SELECT i.*, r.slug AS event_slug, r.name AS event_name, r.ends_on
     FROM invites i JOIN regattas r ON r.id = i.regatta_id
     WHERE i.id = ? AND i.token_hash = ? LIMIT 1`,
  ).bind(inviteId, tokenHash).first<InviteRow>()
  if (!invite) throw new Response('招待URLを確認できません', { status: 404 })
  assertInviteActive(invite)
  return invite
}

async function ownerAccess(request: Request, env: AppEnv, eventReference: string): Promise<EventAccess> {
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) throw new Response('大会管理者のみ操作できます', { status: 403 })
  return access
}

async function createInvite(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const access = await ownerAccess(request, env, eventReference)
  const body = await readJson<{
    role?: string
    assignment?: string
    raceAreaId?: string
    committeeBoatId?: string
    markId?: string
    maxUses?: number | null
    expiresAt?: string | null
  }>(request, 16_384)
  const role = stringValue(body.role, 'role')
  if (!INVITE_ROLES.has(role)) return json({ error: '招待できない役割です' }, { status: 400 })
  const assigned = stringValue(body.assignment, 'assignment', 100)
  const maxUses = body.maxUses == null ? null : Math.trunc(body.maxUses)
  if (maxUses != null && (maxUses < 1 || maxUses > 500)) return json({ error: '使用回数は1〜500で指定してください' }, { status: 400 })
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return json({ error: '有効期限は将来の日時にしてください' }, { status: 400 })
  }

  if (body.committeeBoatId) {
    const boat = await env.DB.prepare(
      'SELECT id FROM committee_boats WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(body.committeeBoatId, access.eventId).first()
    if (!boat) return json({ error: '運営ボートが大会に存在しません' }, { status: 400 })
  }
  if (body.markId) {
    const mark = await env.DB.prepare(
      'SELECT id FROM marks WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(body.markId, access.eventId).first()
    if (!mark) return json({ error: 'マークが大会に存在しません' }, { status: 400 })
  }

  const id = crypto.randomUUID()
  const secret = randomToken(32)
  const tokenHash = await sha256Base64Url(secret)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO invites
     (id, regatta_id, token_hash, role, assignment_scope_json, race_area_id,
      committee_boat_id, mark_id, max_uses, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    access.eventId,
    tokenHash,
    role,
    JSON.stringify({ assignment: assigned }),
    body.raceAreaId ?? null,
    body.committeeBoatId ?? null,
    body.markId ?? null,
    maxUses,
    expiresAt?.toISOString() ?? null,
    access.userId,
    now,
  ).run()
  await appendAuditEvent(env, {
    access,
    action: 'invite.create',
    entityType: 'invite',
    entityId: id,
    after: { role, assignment: assigned, maxUses, expiresAt: expiresAt?.toISOString() ?? null },
  })
  return json({
    invite: { id, role, assignment: assigned, maxUses, useCount: 0, expiresAt: expiresAt?.toISOString() ?? null },
    url: `/e/${encodeURIComponent(access.eventSlug)}/join/${encodeURIComponent(id)}#token=${encodeURIComponent(secret)}`,
  }, { status: 201 })
}

async function listInvites(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  const access = await ownerAccess(request, env, eventReference)
  const rows = await env.DB.prepare(
    `SELECT id, role, assignment_scope_json, race_area_id, committee_boat_id, mark_id,
            max_uses, use_count, expires_at, revoked_at, created_at
     FROM invites WHERE regatta_id = ? ORDER BY created_at DESC`,
  ).bind(access.eventId).all()
  return json({ invites: rows.results.map((row) => {
    const item = row as Record<string, unknown>
    let assigned = String(item.role)
    try {
      const parsed = JSON.parse(String(item.assignment_scope_json)) as { assignment?: string }
      assigned = parsed.assignment ?? assigned
    } catch { /* Retain the role as a safe display fallback. */ }
    const { assignment_scope_json: _, ...safe } = item
    void _
    return { ...safe, assignment: assigned }
  }) })
}

async function revokeInvite(request: Request, env: AppEnv, eventReference: string, inviteId: string): Promise<Response> {
  assertSameOrigin(request)
  const access = await ownerAccess(request, env, eventReference)
  const now = new Date().toISOString()
  const result = await env.DB.prepare(
    'UPDATE invites SET revoked_at = ? WHERE id = ? AND regatta_id = ? AND revoked_at IS NULL',
  ).bind(now, inviteId, access.eventId).run()
  if (!result.meta.changes) return json({ error: '有効な招待が見つかりません' }, { status: 404 })
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_sessions SET revoked_at = ?
       WHERE user_id IN (SELECT user_id FROM event_members WHERE invite_id = ? AND user_id IS NOT NULL)`,
    ).bind(now, inviteId),
    env.DB.prepare(
      `UPDATE event_members SET status = 'revoked' WHERE invite_id = ? AND status <> 'revoked'`,
    ).bind(inviteId),
  ])
  await appendAuditEvent(env, {
    access,
    action: 'invite.revoke',
    entityType: 'invite',
    entityId: inviteId,
    after: { revokedAt: now, sessionsRevoked: true },
  })
  return json({ revoked: true, revokedAt: now })
}

async function previewInvite(request: Request, env: AppEnv, inviteId: string): Promise<Response> {
  assertSameOrigin(request)
  const body = await readJson<{ secret?: string }>(request, 4_096)
  const invite = await inviteBySecret(env, inviteId, stringValue(body.secret, 'invite secret', 200))
  return json({
    event: { slug: invite.event_slug, name: invite.event_name },
    invite: { id: invite.id, role: invite.role, assignment: assignment(invite), expiresAt: invite.expires_at },
  })
}

async function exchangeInvite(request: Request, env: AppEnv, inviteId: string): Promise<Response> {
  assertSameOrigin(request)
  const body = await readJson<{ secret?: string; displayName?: string; recoverySecret?: string }>(request, 16_384)
  const invite = await inviteBySecret(env, inviteId, stringValue(body.secret, 'invite secret', 200))
  const displayName = stringValue(body.displayName, 'displayName', 80)
  const recoverySecret = stringValue(body.recoverySecret, 'recoverySecret', 300)
  if (recoverySecret.length < 22) return json({ error: '復元秘密が短すぎます' }, { status: 400 })
  const currentSession = await getSession(request, env)
  if (invite.role === 'pro' || invite.role === 'ro') {
    if (!currentSession) return json({ error: 'PRO/ROは先にパスキーでログインしてください' }, { status: 403 })
    const credential = await env.DB.prepare(
      'SELECT id FROM passkey_credentials WHERE user_id = ? LIMIT 1',
    ).bind(currentSession.userId).first()
    if (!credential) return json({ error: 'PRO/ROにはパスキー登録が必要です' }, { status: 403 })
  }

  const userId = currentSession?.userId ?? crypto.randomUUID()
  const existing = await env.DB.prepare(
    `SELECT id FROM event_members
     WHERE regatta_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
  ).bind(invite.regatta_id, userId).first()
  if (existing) return json({ error: 'この利用者はすでに大会へ参加しています' }, { status: 409 })

  const consumed = await env.DB.prepare(
    `UPDATE invites SET use_count = use_count + 1
     WHERE id = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (max_uses IS NULL OR use_count < max_uses)`,
  ).bind(invite.id, new Date().toISOString()).run()
  if (!consumed.meta.changes) return json({ error: '招待URLを使用できません' }, { status: 410 })

  const memberId = crypto.randomUUID()
  const recoveryId = crypto.randomUUID()
  const now = new Date().toISOString()
  const recoveryHash = await sha256Base64Url(recoverySecret)
  const recoveryExpiresAt = new Date(Date.parse(`${invite.ends_on}T23:59:59Z`) + 30 * 86_400_000).toISOString()
  const statements: D1PreparedStatement[] = []
  if (!currentSession) {
    statements.push(env.DB.prepare(
      `INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).bind(userId, displayName, now, now))
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO event_members
       (id, regatta_id, user_id, display_name, role, assignment, status, joined_at, invite_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(memberId, invite.regatta_id, userId, displayName, invite.role, assignment(invite), now, invite.id),
    env.DB.prepare(
      `INSERT INTO member_recovery_credentials
       (id, event_member_id, secret_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(recoveryId, memberId, recoveryHash, now, recoveryExpiresAt),
  )
  if (invite.race_area_id || invite.committee_boat_id || invite.mark_id) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_member_scopes
       (id, event_member_id, race_area_id, committee_boat_id, mark_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), memberId, invite.race_area_id, invite.committee_boat_id, invite.mark_id, now))
  }
  await env.DB.batch(statements)

  const access: EventAccess = {
    eventId: invite.regatta_id,
    eventSlug: invite.event_slug,
    eventName: invite.event_name,
    userId,
    memberId,
    displayName,
    role: invite.role,
    assignment: assignment(invite),
    isOwner: false,
  }
  await appendAuditEvent(env, {
    access,
    action: 'invite.exchange',
    entityType: 'event_member',
    entityId: memberId,
    after: { inviteId: invite.id, role: invite.role, assignment: assignment(invite) },
  })
  const created = await createSession(request, env, userId)
  return responseWithCookie({
    authenticated: true,
    user: { id: userId, displayName },
    expiresAt: created.session.expiresAt,
    event: { slug: invite.event_slug, name: invite.event_name },
    member: { id: memberId, displayName, role: invite.role, assignment: assignment(invite) },
    recovery: { issuedAt: now, expiresAt: recoveryExpiresAt },
  }, created.cookie, 201)
}

async function recoverMember(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const body = await readJson<{
    memberId?: string
    recoverySecret?: string
    newRecoverySecret?: string
  }>(request, 16_384)
  const memberId = stringValue(body.memberId, 'memberId')
  const recoverySecret = stringValue(body.recoverySecret, 'recoverySecret', 300)
  const newRecoverySecret = stringValue(body.newRecoverySecret, 'newRecoverySecret', 300)
  if (newRecoverySecret.length < 22) return json({ error: '新しい復元秘密が短すぎます' }, { status: 400 })
  const event = await env.DB.prepare(
    'SELECT id FROM regattas WHERE id = ? OR slug = ? LIMIT 1',
  ).bind(eventReference, eventReference).first<{ id: string }>()
  if (!event) return json({ error: '大会が見つかりません' }, { status: 404 })
  const since = new Date(Date.now() - 15 * 60_000).toISOString()
  const failures = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM recovery_attempts
     WHERE regatta_id = ? AND event_member_id = ? AND success = 0 AND attempted_at >= ?`,
  ).bind(event.id, memberId, since).first<{ count: number }>()
  if ((failures?.count ?? 0) >= 5) return json({ error: '試行回数が多すぎます。15分後に再試行してください' }, { status: 429 })

  const secretHash = await sha256Base64Url(recoverySecret)
  const credential = await env.DB.prepare(
    `SELECT
       rc.id AS credential_id, rc.event_member_id, em.regatta_id,
       r.slug AS event_slug, r.name AS event_name, em.user_id, em.display_name,
       em.role, em.assignment, rc.expires_at, rc.used_at, rc.revoked_at, em.status AS member_status
     FROM member_recovery_credentials rc
     JOIN event_members em ON em.id = rc.event_member_id
     JOIN regattas r ON r.id = em.regatta_id
     WHERE rc.event_member_id = ? AND em.regatta_id = ? AND rc.secret_hash = ? LIMIT 1`,
  ).bind(memberId, event.id, secretHash).first<RecoveryRow>()
  const attemptedAt = new Date().toISOString()
  const networkHash = await sha256Base64Url(request.headers.get('cf-connecting-ip') ?? 'local')
  if (!credential || credential.member_status !== 'active' || credential.used_at || credential.revoked_at || Date.parse(credential.expires_at) <= Date.now()) {
    await env.DB.prepare(
      `INSERT INTO recovery_attempts (id, regatta_id, event_member_id, attempted_at, success, network_hash)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).bind(crypto.randomUUID(), event.id, memberId, attemptedAt, networkHash).run()
    return json({ error: '復元情報を確認できません' }, { status: 400 })
  }
  if (PRIVILEGED_RECOVERY_ROLES.has(credential.role)) {
    return json({ error: 'この役割の復旧にはパスキーと大会管理者の確認が必要です' }, { status: 403 })
  }

  const replacementId = crypto.randomUUID()
  const newHash = await sha256Base64Url(newRecoverySecret)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO member_recovery_credentials
       (id, event_member_id, secret_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(replacementId, credential.event_member_id, newHash, attemptedAt, credential.expires_at),
    env.DB.prepare(
      `UPDATE member_recovery_credentials SET used_at = ?, replaced_by_id = ? WHERE id = ?`,
    ).bind(attemptedAt, replacementId, credential.credential_id),
    env.DB.prepare(
      'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).bind(attemptedAt, credential.user_id),
    env.DB.prepare(
      `INSERT INTO recovery_attempts (id, regatta_id, event_member_id, attempted_at, success, network_hash)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).bind(crypto.randomUUID(), event.id, memberId, attemptedAt, networkHash),
  ])
  const access: EventAccess = {
    eventId: credential.regatta_id,
    eventSlug: credential.event_slug,
    eventName: credential.event_name,
    userId: credential.user_id,
    memberId: credential.event_member_id,
    displayName: credential.display_name,
    role: credential.role,
    assignment: credential.assignment,
    isOwner: false,
  }
  await appendAuditEvent(env, {
    access,
    action: 'member.recover',
    entityType: 'event_member',
    entityId: memberId,
    after: { credentialsRotated: true, sessionsRevoked: true },
  })
  const created = await createSession(request, env, credential.user_id)
  return responseWithCookie({
    authenticated: true,
    user: { id: credential.user_id, displayName: credential.display_name },
    expiresAt: created.session.expiresAt,
    event: { slug: credential.event_slug, name: credential.event_name },
    member: { id: memberId, displayName: credential.display_name, role: credential.role, assignment: credential.assignment },
    recovery: { issuedAt: attemptedAt, expiresAt: credential.expires_at },
  }, created.cookie)
}

export async function handleInviteRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const collection = pathname.match(/^\/api\/events\/([^/]+)\/invites$/)
  if (collection) {
    const eventReference = decodeURIComponent(collection[1])
    if (request.method === 'GET') return listInvites(request, env, eventReference)
    if (request.method === 'POST') return createInvite(request, env, eventReference)
  }
  const revoke = pathname.match(/^\/api\/events\/([^/]+)\/invites\/([^/]+)\/revoke$/)
  if (request.method === 'POST' && revoke) {
    return revokeInvite(request, env, decodeURIComponent(revoke[1]), decodeURIComponent(revoke[2]))
  }
  const preview = pathname.match(/^\/api\/invites\/([^/]+)\/preview$/)
  if (request.method === 'POST' && preview) return previewInvite(request, env, decodeURIComponent(preview[1]))
  const exchange = pathname.match(/^\/api\/invites\/([^/]+)\/exchange$/)
  if (request.method === 'POST' && exchange) return exchangeInvite(request, env, decodeURIComponent(exchange[1]))
  const recover = pathname.match(/^\/api\/events\/([^/]+)\/recover$/)
  if (request.method === 'POST' && recover) return recoverMember(request, env, decodeURIComponent(recover[1]))
  return null
}
