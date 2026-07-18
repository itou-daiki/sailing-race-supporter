import { appendAuditEvent } from './audit.js'
import {
  isEncryptedBackupArchiveEnvelope,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT,
  MAX_BACKUP_ARCHIVES_PER_EVENT,
} from '../shared/backupArchive.js'
import { eventAccess } from './authorization.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import {
  assertSameOrigin,
  hasRecentAuthentication,
  requireSession,
  sha256Base64Url,
} from './security.js'

const RECENT_EXPORT_WINDOW_MS = 30 * 60_000

export interface BackupArchiveRow {
  id: string
  regatta_id: string
  object_key: string
  ciphertext_hash: string
  server_data_hash: string
  event_sequence: number
  size_bytes: number
  etag: string
  created_by: string
  created_at: string
  deleted_at: string | null
}

async function ownerContext(request: Request, env: AppEnv, eventReference: string) {
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) throw new Response('大会管理者のみ操作できます', { status: 403 })
  return { access, session }
}

function publicArchive(row: BackupArchiveRow) {
  return {
    id: row.id,
    ciphertextHash: row.ciphertext_hash,
    serverDataHash: row.server_data_hash,
    eventSequence: row.event_sequence,
    sizeBytes: row.size_bytes,
    etag: row.etag,
    createdAt: row.created_at,
  }
}

async function listArchives(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  const { access } = await ownerContext(request, env, eventReference)
  const rows = await env.DB.prepare(
    `SELECT * FROM backup_archives
     WHERE regatta_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(access.eventId, MAX_BACKUP_ARCHIVES_PER_EVENT).all<BackupArchiveRow>()
  const sizeBytes = rows.results.reduce((total, row) => total + row.size_bytes, 0)
  return json({
    archives: rows.results.map(publicArchive),
    limits: {
      maxArchives: MAX_BACKUP_ARCHIVES_PER_EVENT,
      maxArchiveBytes: MAX_BACKUP_ARCHIVE_BYTES,
      maxEventBytes: MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT,
      currentBytes: sizeBytes,
    },
  })
}

async function createArchive(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const { access } = await ownerContext(request, env, eventReference)
  const body = await readJson<{
    backup?: unknown
    serverDataHash?: unknown
    eventSequence?: unknown
  }>(request, MAX_BACKUP_ARCHIVE_BYTES + 16 * 1_024)
  if (!isEncryptedBackupArchiveEnvelope(body.backup)) {
    return json({ error: '暗号化バックアップ形式を確認できません' }, { status: 400 })
  }
  if (
    body.backup.event.id !== access.eventId ||
    body.backup.event.slug !== access.eventSlug ||
    body.backup.event.name !== access.eventName
  ) {
    return json({ error: '選択中の大会と暗号化バックアップの大会情報が一致しません' }, { status: 409 })
  }
  if (
    typeof body.serverDataHash !== 'string' ||
    body.serverDataHash.length < 32 || body.serverDataHash.length > 128 ||
    !Number.isInteger(body.eventSequence) || Number(body.eventSequence) < 0
  ) {
    return json({ error: '署名済みバックアップのハッシュまたは監査連番が不正です' }, { status: 400 })
  }
  const recentExport = await env.DB.prepare(
    `SELECT id FROM backup_records
     WHERE regatta_id = ? AND data_hash = ? AND event_sequence = ? AND created_by = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(
    access.eventId,
    body.serverDataHash,
    Number(body.eventSequence),
    access.userId,
    new Date(Date.now() - RECENT_EXPORT_WINDOW_MS).toISOString(),
  ).first<{ id: string }>()
  if (!recentExport) {
    return json({ error: '直前30分以内にサーバーが発行した署名済みバックアップを確認できません' }, { status: 409 })
  }

  const content = JSON.stringify(body.backup)
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
    return json({ error: 'R2保管できるバックアップは25 MiB以下です' }, { status: 413 })
  }
  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS archive_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM backup_archives WHERE regatta_id = ? AND deleted_at IS NULL`,
  ).bind(access.eventId).first<{ archive_count: number; total_bytes: number }>()
  if ((usage?.archive_count ?? 0) >= MAX_BACKUP_ARCHIVES_PER_EVENT) {
    return json({ error: 'R2保管は1大会20世代までです。不要な世代を削除してから再実行してください' }, { status: 409 })
  }
  if ((usage?.total_bytes ?? 0) + bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT) {
    return json({ error: 'この大会のR2バックアップ上限500 MiBを超えます' }, { status: 409 })
  }

  const archiveId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const objectKey = `${access.eventId}/${createdAt.slice(0, 10)}/${archiveId}.srs-backup`
  const ciphertextHash = await sha256Base64Url(content)
  let inserted = false
  try {
    const stored = await env.BACKUP_ARCHIVES.put(objectKey, bytes, {
      httpMetadata: { contentType: 'application/vnd.sailing-race-supporter.backup+json' },
      customMetadata: {
        archiveId,
        eventId: access.eventId,
        ciphertextHash,
        serverDataHash: body.serverDataHash,
        eventSequence: String(body.eventSequence),
      },
    })
    await env.DB.prepare(
      `INSERT INTO backup_archives
       (id, regatta_id, object_key, ciphertext_hash, server_data_hash, event_sequence,
        size_bytes, etag, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      archiveId,
      access.eventId,
      objectKey,
      ciphertextHash,
      body.serverDataHash,
      Number(body.eventSequence),
      bytes.byteLength,
      stored.etag,
      access.userId,
      createdAt,
    ).run()
    inserted = true
    await appendAuditEvent(env, {
      access,
      action: 'backup.archive.create',
      entityType: 'backup_archive',
      entityId: archiveId,
      after: {
        ciphertextHash,
        serverDataHash: body.serverDataHash,
        eventSequence: body.eventSequence,
        sizeBytes: bytes.byteLength,
        etag: stored.etag,
      },
    })
    const row: BackupArchiveRow = {
      id: archiveId,
      regatta_id: access.eventId,
      object_key: objectKey,
      ciphertext_hash: ciphertextHash,
      server_data_hash: body.serverDataHash,
      event_sequence: Number(body.eventSequence),
      size_bytes: bytes.byteLength,
      etag: stored.etag,
      created_by: access.userId,
      created_at: createdAt,
      deleted_at: null,
    }
    return json({ archive: publicArchive(row) }, { status: 201 })
  } catch (error) {
    await env.BACKUP_ARCHIVES.delete(objectKey).catch(() => undefined)
    if (inserted) {
      await env.DB.prepare('DELETE FROM backup_archives WHERE id = ?').bind(archiveId).run().catch(() => undefined)
    }
    throw error
  }
}

async function archiveRow(env: AppEnv, eventId: string, archiveId: string): Promise<BackupArchiveRow | null> {
  return env.DB.prepare(
    `SELECT * FROM backup_archives
     WHERE id = ? AND regatta_id = ? AND deleted_at IS NULL LIMIT 1`,
  ).bind(archiveId, eventId).first<BackupArchiveRow>()
}

async function downloadArchive(
  request: Request,
  env: AppEnv,
  eventReference: string,
  archiveId: string,
): Promise<Response> {
  const { access } = await ownerContext(request, env, eventReference)
  const row = await archiveRow(env, access.eventId, archiveId)
  if (!row) return json({ error: 'R2バックアップが見つかりません' }, { status: 404 })
  const object = await env.BACKUP_ARCHIVES.get(row.object_key)
  if (!object) return json({ error: 'R2上のバックアップ本体が見つかりません' }, { status: 410 })
  if (object.size !== row.size_bytes || object.etag !== row.etag) {
    return json({ error: 'R2バックアップのサイズまたはETagが記録と一致しません' }, { status: 409 })
  }
  const filename = `${access.eventSlug}-${row.created_at.slice(0, 10)}-${row.id.slice(0, 8)}.srs-backup`
  return new Response(object.body, {
    headers: {
      'content-type': 'application/vnd.sailing-race-supporter.backup+json',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      etag: object.httpEtag,
      'x-content-type-options': 'nosniff',
    },
  })
}

async function deleteArchive(
  request: Request,
  env: AppEnv,
  eventReference: string,
  archiveId: string,
): Promise<Response> {
  assertSameOrigin(request)
  const { access, session } = await ownerContext(request, env, eventReference)
  if (!hasRecentAuthentication(session)) {
    return json({
      error: 'R2バックアップ削除にはパスキーでの再認証が必要です。再認証後15分以内にもう一度実行してください',
      code: 'REAUTHENTICATION_REQUIRED',
    }, { status: 428 })
  }
  const body = await readJson<{ confirmation?: string }>(request, 4_096)
  if (body.confirmation !== archiveId) {
    return json({ error: '削除確認識別子が一致しません' }, { status: 400 })
  }
  const row = await archiveRow(env, access.eventId, archiveId)
  if (!row) return json({ error: 'R2バックアップが見つかりません' }, { status: 404 })
  const deletedAt = new Date().toISOString()
  await env.BACKUP_ARCHIVES.delete(row.object_key)
  await env.DB.prepare(
    'UPDATE backup_archives SET deleted_at = ? WHERE id = ? AND regatta_id = ? AND deleted_at IS NULL',
  ).bind(deletedAt, row.id, access.eventId).run()
  await appendAuditEvent(env, {
    access,
    action: 'backup.archive.delete',
    entityType: 'backup_archive',
    entityId: row.id,
    before: publicArchive(row),
    after: { deletedAt },
    reason: '大会管理者が暗号化R2バックアップを削除',
  })
  return json({ deleted: true, archiveId: row.id, deletedAt })
}

export async function handleBackupArchiveRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const collectionMatch = pathname.match(/^\/api\/events\/([^/]+)\/backup-archives$/)
  if (collectionMatch) {
    const eventReference = decodeURIComponent(collectionMatch[1])
    if (request.method === 'GET') return listArchives(request, env, eventReference)
    if (request.method === 'POST') return createArchive(request, env, eventReference)
    return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } })
  }
  const itemMatch = pathname.match(/^\/api\/events\/([^/]+)\/backup-archives\/([^/]+)$/)
  if (!itemMatch) return null
  const eventReference = decodeURIComponent(itemMatch[1])
  const archiveId = decodeURIComponent(itemMatch[2])
  if (request.method === 'GET') return downloadArchive(request, env, eventReference, archiveId)
  if (request.method === 'DELETE') return deleteArchive(request, env, eventReference, archiveId)
  return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, DELETE' } })
}
