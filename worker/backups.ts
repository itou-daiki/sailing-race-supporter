import { eventAccess } from './authorization.js'
import { appendAuditEvent, canonical } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession, sha256Base64Url } from './security.js'
import { signBackup, verifyBackupSignature, type BackupSignature } from '../shared/backupSignature.js'

interface ServerBackup {
  format: 'srs-server-backup'
  schemaVersion: 1 | 2
  createdAt: string
  createdBy: string
  scope: 'records'
  event: { id: string; slug: string; name: string }
  manifest: {
    dataHash: string
    eventSequence: number
    eventHashRoot: string | null
    counts: Record<string, number>
    signature?: BackupSignature
  }
  data: Record<string, unknown[]>
}

interface RestorePreviewItem {
  raceId: string
  raceNumber: string
  status: string
  action: 'restore' | 'skip-finalized' | 'skip-unchanged' | 'skip-no-source'
  sourceRevisionId: string | null
  sourceRevision: number | null
  sourceCourseCode: string | null
  sourceNodeCount: number
  currentRevision: number
  currentCourseCode: string | null
  createdRevision: number | null
  differences: string[]
}

interface RestorePreview {
  generatedAt: string
  stateHash: string
  backupHash: string
  backupCreatedAt: string
  backupSequence: number
  items: RestorePreviewItem[]
  restorableCount: number
  finalizedSkippedCount: number
  unchangedSkippedCount: number
  noSourceCount: number
}

async function ownerContext(request: Request, env: AppEnv, eventReference: string) {
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) throw new Response('大会管理者のみ操作できます', { status: 403 })
  return { access, session }
}

async function all(env: AppEnv, sql: string, eventId: string): Promise<unknown[]> {
  return (await env.DB.prepare(sql).bind(eventId).all()).results
}

async function createBackup(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const { access } = await ownerContext(request, env, eventReference)
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
    currentObservations,
    signalEvents,
    leadingPassages,
    leadingPassageObservations,
    leadingPassageAdoptions,
    finishObservations,
    finishAdoptions,
    operationalTasks,
    operationalTaskEvents,
    officialAudioDevices,
    officialAudioDeviceEvents,
    messages,
    messageTargets,
    messageReceipts,
    raceFinalizations,
    postFinalizationRevisions,
    auditEvents,
    retentionRuns,
    retentionTombstones,
    retentionHoldEvents,
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
    all(env, 'SELECT * FROM current_observations WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT signal.* FROM signal_events signal JOIN races race ON race.id = signal.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT passage.* FROM leading_passage_events passage JOIN races race ON race.id = passage.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT observation.* FROM leading_passage_observations observation JOIN races race ON race.id = observation.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT adoption.* FROM leading_passage_adoptions adoption JOIN races race ON race.id = adoption.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT observation.* FROM finish_observations observation JOIN races race ON race.id = observation.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT adoption.* FROM finish_adoptions adoption JOIN races race ON race.id = adoption.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT task.* FROM operational_tasks task JOIN races race ON race.id = task.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT event.* FROM operational_task_events event JOIN races race ON race.id = event.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, `SELECT device.race_id, device.device_id, device.device_label, device.member_id,
                    device.readiness_json, device.claimed_at, device.ready_at,
                    device.last_seen_at, device.released_at
             FROM official_audio_devices device
             JOIN races race ON race.id = device.race_id WHERE race.regatta_id = ?`, access.eventId),
    all(env, `SELECT event.id, event.race_id, event.device_id, event.device_label,
                    event.member_id, event.action, event.readiness_json, event.created_at
             FROM official_audio_device_events event
             JOIN races race ON race.id = event.race_id WHERE race.regatta_id = ?`, access.eventId),
    all(env, 'SELECT * FROM messages WHERE regatta_id = ?', access.eventId),
    all(env, 'SELECT target.* FROM message_targets target JOIN messages message ON message.id = target.message_id WHERE message.regatta_id = ?', access.eventId),
    all(env, 'SELECT receipt.* FROM message_receipts receipt JOIN messages message ON message.id = receipt.message_id WHERE message.regatta_id = ?', access.eventId),
    all(env, 'SELECT finalization.* FROM race_finalizations finalization JOIN races race ON race.id = finalization.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT revision.* FROM post_finalization_revisions revision JOIN races race ON race.id = revision.race_id WHERE race.regatta_id = ?', access.eventId),
    all(env, 'SELECT * FROM audit_events WHERE regatta_id = ? ORDER BY sequence', access.eventId),
    all(env, 'SELECT * FROM retention_runs WHERE regatta_id = ? ORDER BY started_at', access.eventId),
    all(env, 'SELECT * FROM retention_tombstones WHERE regatta_id = ? ORDER BY deleted_at', access.eventId),
    all(env, 'SELECT * FROM retention_hold_events WHERE regatta_id = ? ORDER BY created_at', access.eventId),
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
    currentObservations,
    signalEvents,
    leadingPassages,
    leadingPassageObservations,
    leadingPassageAdoptions,
    finishObservations,
    finishAdoptions,
    operationalTasks,
    operationalTaskEvents,
    officialAudioDevices,
    officialAudioDeviceEvents,
    messages,
    messageTargets,
    messageReceipts,
    raceFinalizations,
    postFinalizationRevisions,
    auditEvents,
    retentionRuns,
    retentionTombstones,
    retentionHoldEvents,
    invites,
  }
  const dataHash = await sha256Base64Url(JSON.stringify(canonical(data)))
  const lastAudit = (auditEvents.at(-1) ?? null) as { sequence?: number; event_hash?: string } | null
  const createdAt = new Date().toISOString()
  const backup: ServerBackup = {
    format: 'srs-server-backup',
    schemaVersion: 2,
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
  backup.manifest.signature = await signBackup(backup, env.BACKUP_SIGNING_PRIVATE_KEY)
  if (!await verifyBackupSignature(backup)) {
    return json({ error: 'バックアップ署名鍵と公開鍵設定が一致しません' }, { status: 503 })
  }
  const recordId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO backup_records
     (id, regatta_id, format_version, scope, data_hash, event_sequence, created_by, created_at)
     VALUES (?, ?, 2, 'records', ?, ?, ?, ?)`,
  ).bind(recordId, access.eventId, dataHash, backup.manifest.eventSequence, access.userId, createdAt).run()
  await appendAuditEvent(env, {
    access,
    action: 'backup.create',
    entityType: 'backup',
    entityId: recordId,
    after: {
      dataHash,
      eventSequence: backup.manifest.eventSequence,
      counts: backup.manifest.counts,
      signatureKeyId: backup.manifest.signature.keyId,
    },
  })
  return json({ backup })
}

function records<T extends Record<string, unknown>>(backup: ServerBackup, key: string): T[] {
  const values = backup.data[key]
  if (!Array.isArray(values)) throw new Response(`Backup section missing: ${key}`, { status: 400 })
  return values as T[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function validateRestorableBackup(backup: ServerBackup | undefined, eventId: string): Promise<Response | null> {
  if (
    !isRecord(backup) ||
    backup.format !== 'srs-server-backup' ||
    backup.schemaVersion !== 2 ||
    !isRecord(backup.event) ||
    !isRecord(backup.manifest) ||
    !isRecord(backup.data)
  ) return json({ error: '署名付き形式v2のバックアップが必要です' }, { status: 400 })
  if (backup.event.id !== eventId) {
    return json({ error: '別大会のバックアップは現在の大会へ復元できません' }, { status: 409 })
  }
  const calculatedHash = await sha256Base64Url(JSON.stringify(canonical(backup.data)))
  if (calculatedHash !== backup.manifest.dataHash) {
    return json({ error: 'バックアップのデータハッシュが一致しません' }, { status: 400 })
  }
  if (!await verifyBackupSignature(backup)) {
    return json({ error: '有効なEd25519サーバー署名を確認できないため復元できません' }, { status: 400 })
  }
  return null
}

function nodeFingerprint(nodes: Record<string, unknown>[]): unknown[] {
  return nodes
    .slice()
    .sort((left, right) => Number(left.node_order) - Number(right.node_order))
    .map((node) => ({
      order: Number(node.node_order),
      markId: node.mark_id ?? null,
      label: String(node.label),
      type: String(node.node_type),
      rounding: node.rounding ?? null,
      longitude: Number(node.target_lng),
      latitude: Number(node.target_lat),
    }))
}

function jsonFingerprint(value: unknown): string {
  try {
    return JSON.stringify(canonical(JSON.parse(String(value ?? '{}'))))
  } catch {
    return String(value ?? '{}')
  }
}

async function buildRestorePreview(env: AppEnv, eventId: string, backup: ServerBackup): Promise<RestorePreview> {
  const backupRevisions = records<Record<string, unknown>>(backup, 'courseRevisions')
  const backupNodes = records<Record<string, unknown>>(backup, 'courseNodes')
  const currentRaces = (await env.DB.prepare(
    `SELECT race.id, race.race_number, race.status,
            revision.id AS current_revision_id, revision.revision AS current_revision,
            revision.course_code AS current_course_code,
            revision.wind_direction AS current_wind_direction,
            revision.wind_speed AS current_wind_speed,
            revision.target_length_metres AS current_target_length_metres,
            revision.gate_config_json AS current_gate_config_json
     FROM races race
     LEFT JOIN course_revisions revision ON revision.id = (
       SELECT candidate.id FROM course_revisions candidate
       WHERE candidate.race_id = race.id ORDER BY candidate.revision DESC LIMIT 1
     )
     WHERE race.regatta_id = ? ORDER BY race.race_order`,
  ).bind(eventId).all<Record<string, unknown>>()).results
  const currentNodes = (await env.DB.prepare(
    `SELECT revision.race_id, node.*
     FROM course_nodes node
     JOIN course_revisions revision ON revision.id = node.course_revision_id
     JOIN races race ON race.id = revision.race_id
     WHERE race.regatta_id = ?
       AND revision.revision = (
         SELECT MAX(candidate.revision) FROM course_revisions candidate WHERE candidate.race_id = revision.race_id
       )
     ORDER BY revision.race_id, node.node_order`,
  ).bind(eventId).all<Record<string, unknown>>()).results
  const currentMarkIds = (await env.DB.prepare(
    'SELECT id FROM marks WHERE regatta_id = ? ORDER BY id',
  ).bind(eventId).all<{ id: string }>()).results.map((mark) => mark.id)

  const items = currentRaces.map((race): RestorePreviewItem => {
    const candidates = backupRevisions
      .filter((revision) => revision.race_id === race.id)
      .sort((left, right) => Number(right.revision) - Number(left.revision))
    const source = candidates[0]
    const currentRevision = Number(race.current_revision ?? 0)
    if (!source) {
      return {
        raceId: String(race.id), raceNumber: String(race.race_number), status: String(race.status),
        action: 'skip-no-source', sourceRevisionId: null, sourceRevision: null, sourceCourseCode: null,
        sourceNodeCount: 0, currentRevision, currentCourseCode: race.current_course_code ? String(race.current_course_code) : null,
        createdRevision: null, differences: [],
      }
    }
    const sourceNodes = backupNodes.filter((node) => node.course_revision_id === source.id)
    const raceCurrentNodes = currentNodes.filter((node) => node.race_id === race.id)
    const differences: string[] = []
    if (source.course_code !== race.current_course_code) differences.push('コース記号')
    if (Number(source.target_length_metres) !== Number(race.current_target_length_metres)) differences.push('目標コース長')
    if (jsonFingerprint(source.gate_config_json) !== jsonFingerprint(race.current_gate_config_json)) differences.push('ゲート構成')
    if (
      Number(source.wind_direction) !== Number(race.current_wind_direction) ||
      Number(source.wind_speed) !== Number(race.current_wind_speed)
    ) differences.push('採用風向・風速')
    if (JSON.stringify(canonical(nodeFingerprint(sourceNodes))) !== JSON.stringify(canonical(nodeFingerprint(raceCurrentNodes)))) {
      differences.push('回航順序・目標位置')
    }
    const action = race.status === 'finalized'
      ? 'skip-finalized'
      : differences.length ? 'restore' : 'skip-unchanged'
    return {
      raceId: String(race.id),
      raceNumber: String(race.race_number),
      status: String(race.status),
      action,
      sourceRevisionId: String(source.id),
      sourceRevision: Number(source.revision),
      sourceCourseCode: String(source.course_code),
      sourceNodeCount: sourceNodes.length,
      currentRevision,
      currentCourseCode: race.current_course_code ? String(race.current_course_code) : null,
      createdRevision: action === 'restore' ? currentRevision + 1 : null,
      differences,
    }
  })
  const stateHash = await sha256Base64Url(JSON.stringify(canonical({
    backupHash: backup.manifest.dataHash,
    races: currentRaces,
    nodes: currentNodes.map((node) => ({ raceId: node.race_id, ...nodeFingerprint([node])[0] as Record<string, unknown> })),
    markIds: currentMarkIds,
  })))
  return {
    generatedAt: new Date().toISOString(),
    stateHash,
    backupHash: backup.manifest.dataHash,
    backupCreatedAt: backup.createdAt,
    backupSequence: backup.manifest.eventSequence,
    items,
    restorableCount: items.filter((item) => item.action === 'restore').length,
    finalizedSkippedCount: items.filter((item) => item.action === 'skip-finalized').length,
    unchangedSkippedCount: items.filter((item) => item.action === 'skip-unchanged').length,
    noSourceCount: items.filter((item) => item.action === 'skip-no-source').length,
  }
}

async function previewRestore(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const { access } = await ownerContext(request, env, eventReference)
  const body = await readJson<{ backup?: ServerBackup }>(request, 5 * 1_024 * 1_024)
  const error = await validateRestorableBackup(body.backup, access.eventId)
  if (error) return error
  return json({ preview: await buildRestorePreview(env, access.eventId, body.backup as ServerBackup) })
}

async function restoreBackup(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  assertSameOrigin(request)
  const { access, session } = await ownerContext(request, env, eventReference)
  if (!hasRecentAuthentication(session)) {
    return json({
      error: 'バックアップ復元にはパスキーでの再認証が必要です。再認証後15分以内にもう一度実行してください',
      code: 'REAUTHENTICATION_REQUIRED',
    }, { status: 428 })
  }
  const body = await readJson<{ backup?: ServerBackup; reason?: string; previewStateHash?: string }>(request, 5 * 1_024 * 1_024)
  const backup = body.backup
  const reason = body.reason?.trim()
  const backupError = await validateRestorableBackup(backup, access.eventId)
  if (backupError) return backupError
  if (!reason || reason.length < 5 || reason.length > 500) {
    return json({ error: '復元理由を5〜500文字で入力してください' }, { status: 400 })
  }
  const verifiedBackup = backup as ServerBackup
  const preview = await buildRestorePreview(env, access.eventId, verifiedBackup)
  if (!body.previewStateHash || body.previewStateHash !== preview.stateHash) {
    return json({ error: '差分確認後に大会状態が変わりました。復元差分をもう一度確認してください' }, { status: 409 })
  }

  const backupRevisions = records<Record<string, unknown>>(verifiedBackup, 'courseRevisions')
  const backupNodes = records<Record<string, unknown>>(verifiedBackup, 'courseNodes')
  const currentMarks = new Set((await env.DB.prepare(
    'SELECT id FROM marks WHERE regatta_id = ?',
  ).bind(access.eventId).all<{ id: string }>()).results.map((mark) => mark.id))
  const statements: D1PreparedStatement[] = []
  const restored: Array<{ raceId: string; raceNumber: string; sourceRevision: number; revision: number; differences: string[] }> = []
  const finalizedSkipped = preview.items.filter((item) => item.action === 'skip-finalized').map((item) => item.raceId)
  const unchangedSkipped = preview.items.filter((item) => item.action === 'skip-unchanged').map((item) => item.raceId)
  const noSourceSkipped = preview.items.filter((item) => item.action === 'skip-no-source').map((item) => item.raceId)
  const now = new Date().toISOString()

  for (const item of preview.items.filter((candidate) => candidate.action === 'restore')) {
    const source = backupRevisions.find((revision) => revision.id === item.sourceRevisionId)
    if (!source) continue
    const nextRevision = item.createdRevision as number
    const revisionId = crypto.randomUUID()
    statements.push(env.DB.prepare(
      `INSERT INTO course_revisions
       (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
        gate_config_json, status, based_on_revision, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(
      revisionId,
      item.raceId,
      nextRevision,
      String(source.course_code),
      source.wind_direction ?? null,
      source.wind_speed ?? null,
      source.target_length_metres ?? null,
      String(source.gate_config_json ?? '{}'),
      item.currentRevision || null,
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
    restored.push({
      raceId: item.raceId,
      raceNumber: item.raceNumber,
      sourceRevision: item.sourceRevision as number,
      revision: nextRevision,
      differences: item.differences,
    })
  }
  if (!restored.length) {
    return json({ error: '差分のある未確定レースがないため、復元版は作成されません' }, { status: 409 })
  }
  const restoreId = crypto.randomUUID()
  statements.push(env.DB.prepare(
    `INSERT INTO restore_records
     (id, regatta_id, backup_hash, restored_by, source_revision, created_revision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    restoreId,
    access.eventId,
    verifiedBackup.manifest.dataHash,
    access.userId,
    verifiedBackup.manifest.eventSequence,
    Math.max(...restored.map((item) => item.revision)),
    reason,
    now,
  ))
  await env.DB.batch(statements)
  const audit = await appendAuditEvent(env, {
    access,
    action: 'backup.restore',
    entityType: 'restore',
    entityId: restoreId,
    after: { backupHash: verifiedBackup.manifest.dataHash, restored, finalizedSkipped, unchangedSkipped, noSourceSkipped },
    reason,
  })
  return json({
    restored,
    finalizedSkipped,
    unchangedSkipped,
    noSourceSkipped,
    restoreId,
    backupHash: verifiedBackup.manifest.dataHash,
    report: {
      format: 'srs-restore-report',
      schemaVersion: 1,
      createdAt: now,
      createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
      event: verifiedBackup.event,
      restoreId,
      reason,
      source: {
        backupCreatedAt: verifiedBackup.createdAt,
        dataHash: verifiedBackup.manifest.dataHash,
        eventSequence: verifiedBackup.manifest.eventSequence,
        signatureKeyId: verifiedBackup.manifest.signature?.keyId ?? null,
      },
      result: { restored, finalizedSkipped, unchangedSkipped, noSourceSkipped },
      audit: { sequence: audit.sequence, eventHash: audit.eventHash },
    },
  })
}

export async function handleBackupRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const exportMatch = pathname.match(/^\/api\/events\/([^/]+)\/backups\/export$/)
  if (request.method === 'POST' && exportMatch) {
    return createBackup(request, env, decodeURIComponent(exportMatch[1]))
  }
  const previewMatch = pathname.match(/^\/api\/events\/([^/]+)\/backups\/restore-preview$/)
  if (request.method === 'POST' && previewMatch) {
    return previewRestore(request, env, decodeURIComponent(previewMatch[1]))
  }
  const restoreMatch = pathname.match(/^\/api\/events\/([^/]+)\/backups\/restore$/)
  if (request.method === 'POST' && restoreMatch) {
    return restoreBackup(request, env, decodeURIComponent(restoreMatch[1]))
  }
  return null
}
