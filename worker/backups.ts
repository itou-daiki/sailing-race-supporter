import { eventAccess, type EventAccess } from './authorization.js'
import { appendAuditEvent, canonical } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, requireSession, sha256Base64Url } from './security.js'

interface ServerBackup {
  format: 'srs-server-backup'
  schemaVersion: 1
  createdAt: string
  createdBy: string
  scope: 'records'
  event: { id: string; slug: string; name: string }
  manifest: {
    dataHash: string
    eventSequence: number
    eventHashRoot: string | null
    counts: Record<string, number>
  }
  data: Record<string, unknown[]>
}

async function ownerAccess(request: Request, env: AppEnv, eventReference: string): Promise<EventAccess> {
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) throw new Response('大会管理者のみ操作できます', { status: 403 })
  return access
}

async function all(env: AppEnv, sql: string, eventId: string): Promise<unknown[]> {
  return (await env.DB.prepare(sql).bind(eventId).all()).results
}

async function createBackup(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const access = await ownerAccess(request, env, eventReference)
  const [
    regattas,
    settings,
    members,
    memberScopes,
    raceAreas,
    races,
    courseRevisions,
    courseNodes,
    marks,
    markEvents,
    committeeBoats,
    boatAssignments,
    positionSamples,
    windObservations,
    signalEvents,
    leadingPassages,
    operationalTasks,
    messages,
    messageReceipts,
    raceFinalizations,
    auditEvents,
    invites,
  ] = await Promise.all([
    all(env, 'SELECT id, slug, name, owner_user_id, starts_on, ends_on, status, default_locale, created_at, updated_at FROM regattas WHERE id = ?', access.eventId),
    all(env, 'SELECT * FROM regatta_settings WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT id, regatta_id, user_id, display_name, role, assignment, status, joined_at, invite_id FROM event_members WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT scope.* FROM event_member_scopes scope JOIN event_members member ON member.id = scope.event_member_id WHERE member.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM race_areas WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM races WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT revision.* FROM course_revisions revision JOIN races race ON race.id = revision.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT node.* FROM course_nodes node JOIN course_revisions revision ON revision.id = node.course_revision_id JOIN races race ON race.id = revision.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM marks WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT event.* FROM mark_events event JOIN races race ON race.id = event.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM committee_boats WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT assignment.* FROM boat_assignments assignment JOIN races race ON race.id = assignment.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM position_samples WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM wind_observations WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT signal.* FROM signal_events signal JOIN races race ON race.id = signal.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT passage.* FROM leading_passage_events passage JOIN races race ON race.id = passage.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT task.* FROM operational_tasks task JOIN races race ON race.id = task.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM messages WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT receipt.* FROM message_receipts receipt JOIN messages message ON message.id = receipt.message_id WHERE message.regatta_id = ?', access.eventId),
    all(env, 'SELECT finalization.* FROM race_finalizations finalization JOIN races race ON race.id = finalization.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM audit_events WHERE regatta_id = ? ORDER BY sequence', access.eventId),
    all(env, `SELECT id, regatta_id, role, assignment_scope_json, race_area_id, committee_boat_id,
                    mark_id, max_uses, use_count, expires_at, revoked_at, created_by, created_at
             FROM invites WHERE regatta_id = ?`, access.eventId),
  ])
  const data: Record<string, unknown[]> = {
    regattas,
    settings,
    members,
    memberScopes,
    raceAreas,
    races,
    courseRevisions,
    courseNodes,
    marks,
    markEvents,
    committeeBoats,
    boatAssignments,
    positionSamples,
    windObservations,
    signalEvents,
    leadingPassages,
    operationalTasks,
    messages,
    messageReceipts,
    raceFinalizations,
    auditEvents,
    invites,
  }
  const dataHash = await sha256Base64Url(JSON.stringify(canonical(data)))
  const lastAudit = (auditEvents.at(-1) ?? null) as { sequence?: number; event_hash?: string } | null
  const createdAt = new Date().toISOString()
  const backup: ServerBackup = {
    format: 'srs-server-backup',
    schemaVersion: 1,
    createdAt,
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    scope: 'records',
    event: { id: access.eventId, slug: access.eventSlug, name: access.eventName },
    manifest: {
      dataHash,
      eventSequence: lastAudit?.sequence ?? 0,
      eventHashRoot: lastAudit?.event_hash ?? null,
      counts: Object.fromEntries(Object.entries(data).map(([key, values]) => [key, values.length])),
    },
    data,
  }
  const recordId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO backup_records
     (id, regatta_id, format_version, scope, data_hash, event_sequence, created_by, created_at)
     VALUES (?, ?, 1, 'records', ?, ?, ?, ?)`,
  ).bind(recordId, access.eventId, dataHash, backup.manifest.eventSequence, access.userId, createdAt).run()
  await appendAuditEvent(env, {
    access,
    action: 'backup.create',
    entityType: 'backup',
    entityId: recordId,
    after: { dataHash, eventSequence: backup.manifest.eventSequence, counts: backup.manifest.counts },
  })
  return json({ backup })
}

function records<T extends Record<string, unknown>>(backup: ServerBackup, key: string): T[] {
  const values = backup.data[key]
  if (!Array.isArray(values)) throw new Response(`Backup section missing: ${key}`, { status: 400 })
  return values as T[]
}

async function restoreBackup(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const access = await ownerAccess(request, env, eventReference)
  const body = await readJson<{ backup?: ServerBackup; reason?: string }>(request, 5 * 1_024 * 1_024)
  const backup = body.backup
  const reason = body.reason?.trim()
  if (!backup || backup.format !== 'srs-server-backup' || backup.schemaVersion !== 1) {
    return json({ error: '対応していないバックアップ形式です' }, { status: 400 })
  }
  if (backup.event.id !== access.eventId) {
    return json({ error: '別大会のバックアップは現在の大会へ復元できません' }, { status: 409 })
  }
  if (!reason || reason.length < 5 || reason.length > 500) {
    return json({ error: '復元理由を5〜500文字で入力してください' }, { status: 400 })
  }
  const calculatedHash = await sha256Base64Url(JSON.stringify(canonical(backup.data)))
  if (calculatedHash !== backup.manifest.dataHash) {
    return json({ error: 'バックアップのデータハッシュが一致しません' }, { status: 400 })
  }

  const backupRevisions = records<Record<string, unknown>>(backup, 'courseRevisions')
  const backupNodes = records<Record<string, unknown>>(backup, 'courseNodes')
  const currentRaces = await env.DB.prepare(
    'SELECT id, status FROM races WHERE regatta_id = ? ORDER BY race_order',
  ).bind(access.eventId).all<{ id: string; status: string }>()
  const currentMarks = new Set((await env.DB.prepare(
    'SELECT id FROM marks WHERE regatta_id = ?',
  ).bind(access.eventId).all<{ id: string }>()).results.map((mark) => mark.id))
  const statements: D1PreparedStatement[] = []
  const restored: Array<{ raceId: string; revision: number }> = []
  const finalizedSkipped: string[] = []
  const now = new Date().toISOString()

  for (const race of currentRaces.results) {
    const candidates = backupRevisions
      .filter((revision) => revision.race_id === race.id)
      .sort((left, right) => Number(right.revision) - Number(left.revision))
    const source = candidates[0]
    if (!source) continue
    if (race.status === 'finalized') {
      finalizedSkipped.push(race.id)
      continue
    }
    const current = await env.DB.prepare(
      'SELECT COALESCE(MAX(revision), 0) AS revision FROM course_revisions WHERE race_id = ?',
    ).bind(race.id).first<{ revision: number }>()
    const nextRevision = (current?.revision ?? 0) + 1
    const revisionId = crypto.randomUUID()
    statements.push(env.DB.prepare(
      `INSERT INTO course_revisions
       (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
        gate_config_json, status, based_on_revision, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(
      revisionId,
      race.id,
      nextRevision,
      String(source.course_code),
      source.wind_direction ?? null,
      source.wind_speed ?? null,
      source.target_length_metres ?? null,
      String(source.gate_config_json ?? '{}'),
      current?.revision ?? null,
      access.userId,
      now,
    ))
    const nodes = backupNodes
      .filter((node) => node.course_revision_id === source.id)
      .sort((left, right) => Number(left.node_order) - Number(right.node_order))
    for (const node of nodes) {
      const markId = typeof node.mark_id === 'string' && currentMarks.has(node.mark_id) ? node.mark_id : null
      statements.push(env.DB.prepare(
        `INSERT INTO course_nodes
         (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        revisionId,
        markId,
        Number(node.node_order),
        String(node.label),
        String(node.node_type),
        node.rounding ?? null,
        Number(node.target_lng),
        Number(node.target_lat),
      ))
    }
    restored.push({ raceId: race.id, revision: nextRevision })
  }
  if (!restored.length) {
    return json({ error: finalizedSkipped.length ? '確定済みレースは通常復元できません' : '復元できるコース版がありません' }, { status: 409 })
  }
  const restoreId = crypto.randomUUID()
  statements.push(env.DB.prepare(
    `INSERT INTO restore_records
     (id, regatta_id, backup_hash, restored_by, source_revision, created_revision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    restoreId,
    access.eventId,
    backup.manifest.dataHash,
    access.userId,
    backup.manifest.eventSequence,
    Math.max(...restored.map((item) => item.revision)),
    reason,
    now,
  ))
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access,
    action: 'backup.restore',
    entityType: 'restore',
    entityId: restoreId,
    after: { backupHash: backup.manifest.dataHash, restored, finalizedSkipped },
    reason,
  })
  return json({ restored, finalizedSkipped, restoreId, backupHash: backup.manifest.dataHash })
}

export async function handleBackupRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const exportMatch = pathname.match(/^\/api\/events\/([^/]+)\/backups\/export$/)
  if (request.method === 'POST' && exportMatch) {
    return createBackup(request, env, decodeURIComponent(exportMatch[1]))
  }
  const restoreMatch = pathname.match(/^\/api\/events\/([^/]+)\/backups\/restore$/)
  if (request.method === 'POST' && restoreMatch) {
    return restoreBackup(request, env, decodeURIComponent(restoreMatch[1]))
  }
  return null
}
