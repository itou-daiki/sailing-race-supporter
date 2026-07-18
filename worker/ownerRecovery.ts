import { appendAuditEventWithoutBlockingSecretDelivery } from './audit.js'
import { eventAccess } from './authorization.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession } from './security.js'

function recentAuthenticationRequired(): Response {
  return json({
    error: '復旧キットの保存確定にはパスキーでの再認証が必要です',
    code: 'REAUTHENTICATION_REQUIRED',
  }, { status: 428 })
}

export async function handleOwnerRecoveryRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const confirmMatch = pathname.match(/^\/api\/events\/([^/]+)\/owner-recovery\/([^/]+)\/confirm$/u)
  if (!confirmMatch) return null
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
  }

  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const access = await eventAccess(env, decodeURIComponent(confirmMatch[1]), session.userId, session.displayName)
  if (!access || !access.isOwner) return json({ error: '大会管理者のみ操作できます' }, { status: 403 })
  if (!hasRecentAuthentication(session)) return recentAuthenticationRequired()
  const recoveryId = decodeURIComponent(confirmMatch[2])
  const body = await readJson<{ saved?: boolean }>(request, 4_096)
  if (body.saved !== true) return json({ error: '復旧キットを保存したことを確認してください' }, { status: 400 })

  const credential = await env.DB.prepare(
    `SELECT id, confirmed_at, used_at, revoked_at
     FROM owner_recovery_credentials
     WHERE id = ? AND regatta_id = ? AND owner_user_id = ? LIMIT 1`,
  ).bind(recoveryId, access.eventId, access.userId).first<{
    id: string
    confirmed_at: string | null
    used_at: string | null
    revoked_at: string | null
  }>()
  if (!credential) return json({ error: 'オーナー復旧キットが見つかりません' }, { status: 404 })
  if (credential.used_at || credential.revoked_at) return json({ error: 'この復旧キットは既に失効しています' }, { status: 409 })
  if (credential.confirmed_at) return json({ recoveryId, confirmedAt: credential.confirmed_at, ready: true })

  const confirmedAt = new Date().toISOString()
  const result = await env.DB.prepare(
    `UPDATE owner_recovery_credentials SET confirmed_at = ?
     WHERE id = ? AND confirmed_at IS NULL AND used_at IS NULL AND revoked_at IS NULL`,
  ).bind(confirmedAt, recoveryId).run()
  if (result.meta.changes !== 1) return json({ error: '復旧キットの状態が変更されました。再読込してください' }, { status: 409 })
  const auditRecorded = await appendAuditEventWithoutBlockingSecretDelivery(env, {
    access,
    action: 'owner-recovery.confirm',
    entityType: 'owner_recovery_credential',
    entityId: recoveryId,
    after: { confirmedAt, secretStoredByServer: false },
    reason: '大会管理者がスクリーンショットまたは暗号化ファイルの保存を確認',
  })
  return json({ recoveryId, confirmedAt, ready: true, auditRecorded })
}
