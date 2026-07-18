import { eventAccess, requirePermission, type EventAccess } from './authorization.js'
import { json } from './http.js'
import type { AppEnv } from './index.js'
import { requireSession } from './security.js'

export type LogCategory = 'audit' | 'mark' | 'wind' | 'signal' | 'passage' | 'task' | 'message' | 'position'

export interface EventLogEntry {
  id: string
  raceId: string | null
  raceNumber: string | null
  sequence: number | null
  occurredAt: string
  category: LogCategory
  title: string
  actor: string
  detail: string
  eventHash: string | null
}

type Row = Record<string, unknown>

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function number(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function coordinates(row: Row): string {
  const lng = typeof row.lng === 'number' ? row.lng.toFixed(6) : '—'
  const lat = typeof row.lat === 'number' ? row.lat.toFixed(6) : '—'
  return `${lat}, ${lng}`
}

function taskStatus(status: string): string {
  return ({ blocked: 'ブロッカー', waiting: '確認待ち', doing: '対応中', done: '完了' } as Record<string, string>)[status] ?? status
}

function signalTitle(type: string): string {
  const labels: Record<string, string> = {
    warning: '予告信号', preparatory: '準備信号', 'one-minute': '1分信号', start: 'スタート信号',
    postpone: '延期', 'postpone-h': '延期・陸上で次の信号', 'postpone-a': '延期・本日これ以上なし',
    resume: '延期解除・再予告設定',
    recall: 'リコール', 'individual-recall': '個別リコール', 'individual-recall-clear': '個別リコール終了',
    'general-recall': 'ゼネラルリコール', 'general-recall-clear': '第一代表旗降下・再予告設定',
    abandon: '中止', 'abandon-h': '中止・陸上で次の信号', 'abandon-a': '中止・本日これ以上なし',
    'abandon-clear': 'N旗降下・再予告設定', shorten: 'コース短縮',
    'course-change': '次のレグを変更', 'mark-missing': '欠損マークを代替',
    'search-rescue': '捜索救助通信',
  }
  return labels[type] ?? type
}

function signalDetail(row: Row): string {
  let payload: Record<string, unknown> = {}
  try {
    if (typeof row.payload_json === 'string') payload = JSON.parse(row.payload_json) as Record<string, unknown>
  } catch { /* A malformed historical payload is still represented by its execution record. */ }
  return [
    typeof payload.flag === 'string' ? payload.flag : null,
    typeof payload.sound === 'string' ? payload.sound : null,
    typeof payload.reason === 'string' ? `理由 ${payload.reason}` : null,
    typeof payload.targetSailNumbers === 'string' ? `対象艇 ${payload.targetSailNumbers}` : null,
    typeof payload.finishAt === 'string' ? `短縮フィニッシュ ${payload.finishAt}` : null,
    typeof payload.changeFromMarkLabel === 'string' ? `変更信号位置 ${payload.changeFromMarkLabel}` : null,
    typeof payload.targetMarkLabel === 'string' ? `対象 ${payload.targetMarkLabel}` : null,
    typeof payload.newBearing === 'number' ? `新方位 ${String(Math.round(payload.newBearing)).padStart(3, '0')}°` : null,
    payload.directionChange === 'starboard' ? '右へ変更' : payload.directionChange === 'port' ? '左へ変更' : null,
    payload.lengthChange === 'increase' ? '距離を延長' : payload.lengthChange === 'decrease' ? '距離を短縮' : null,
    typeof payload.replacementObject === 'string' ? `代替物 ${payload.replacementObject}` : null,
    typeof payload.communicationChannel === 'string' ? `通信 ${payload.communicationChannel}` : null,
    typeof payload.safetyInstructions === 'string' ? `捜索救助指示 ${payload.safetyInstructions}` : null,
    row.scheduled_at ? `予定 ${text(row.scheduled_at)}` : null,
    row.visual_executed_at ? `視覚 ${text(row.visual_executed_at)}` : `視覚 ${text(row.occurred_at)}`,
    row.sound_status === 'played' && row.sound_executed_at ? `音響 ${text(row.sound_executed_at)}` : null,
    row.sound_status === 'pending' ? '音響 公式端末待ち' : null,
    row.sound_status === 'not-required' ? '音響 なし' : null,
    row.sound_status === 'legacy' ? '音響 旧記録・不明' : null,
    typeof payload.warningAt === 'string' ? `次の予告 ${payload.warningAt}` : null,
  ].filter(Boolean).join('・') || '実行記録'
}

function csvCell(value: unknown): string {
  let normalized = value == null ? '' : String(value)
  if (/^[=+\-@]/u.test(normalized)) normalized = `'${normalized}`
  return `"${normalized.replaceAll('"', '""')}"`
}

export function eventLogsToCsv(entries: readonly EventLogEntry[]): string {
  const header = ['連番', 'レース', '発生時刻', '種別', '内容', '操作者', '詳細', 'イベントハッシュ']
  const rows = entries.map((entry) => [
    entry.sequence,
    entry.raceNumber ?? '大会全体',
    entry.occurredAt,
    entry.category,
    entry.title,
    entry.actor,
    entry.detail,
    entry.eventHash,
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

async function rows(env: AppEnv, sql: string, values: Array<string | number | null>): Promise<Row[]> {
  return (await env.DB.prepare(sql).bind(...values).all<Row>()).results
}

async function collectLogs(env: AppEnv, access: EventAccess, raceId: string | null, limit: number): Promise<EventLogEntry[]> {
  const regattaId = access.eventId
  const values = [regattaId, raceId, raceId, limit]
  const messageValues = [access.memberId, regattaId, raceId, raceId, access.memberId, access.isOwner ? 1 : 0, limit]
  const [audit, marks, wind, signals, passages, tasks, messages, positions] = await Promise.all([
    rows(env, `SELECT audit.id, audit.race_id, race.race_number, audit.sequence, audit.action,
                      audit.entity_type, audit.reason, audit.server_time AS occurred_at,
                      COALESCE(member.display_name, user.display_name, 'システム') AS actor,
                      audit.event_hash
               FROM audit_events audit
               LEFT JOIN races race ON race.id = audit.race_id
               LEFT JOIN event_members member ON member.id = audit.actor_member_id
               LEFT JOIN users user ON user.id = audit.actor_user_id
               WHERE audit.regatta_id = ? AND (? IS NULL OR audit.race_id = ?)
               ORDER BY audit.server_time DESC LIMIT ?`, values),
    rows(env, `SELECT event.id, event.race_id, race.race_number, event.sequence, event.event_type,
                      event.lng, event.lat, event.server_time AS occurred_at,
                      mark.label, COALESCE(member.display_name, '不明') AS actor
               FROM mark_events event
               JOIN races race ON race.id = event.race_id
               JOIN marks mark ON mark.id = event.mark_id
               LEFT JOIN event_members member ON member.id = event.member_id
               WHERE race.regatta_id = ? AND (? IS NULL OR event.race_id = ?)
               ORDER BY event.server_time DESC LIMIT ?`, values),
    rows(env, `SELECT observation.id, observation.race_id, race.race_number,
                      observation.observed_at AS occurred_at, observation.direction_degrees,
                      observation.speed_knots, observation.gust_knots, observation.source AS actor
               FROM wind_observations observation
               LEFT JOIN races race ON race.id = observation.race_id
               WHERE observation.regatta_id = ? AND (? IS NULL OR observation.race_id = ?)
               ORDER BY observation.observed_at DESC LIMIT ?`, values),
    rows(env, `SELECT event.id, event.race_id, race.race_number, event.signal_type,
                      event.executed_at AS occurred_at, event.scheduled_at,
                      event.visual_executed_at, event.sound_executed_at, event.sound_status,
                      event.payload_json,
                      COALESCE(member.display_name, '不明') AS actor
               FROM signal_events event
               JOIN races race ON race.id = event.race_id
               LEFT JOIN event_members member ON member.id = event.member_id
               WHERE race.regatta_id = ? AND (? IS NULL OR event.race_id = ?)
               ORDER BY event.executed_at DESC LIMIT ?`, values),
    rows(env, `SELECT observation.id, observation.race_id, race.race_number,
                      observation.passed_at AS occurred_at, observation.lap_number,
                      mark.label, observation.sync_quality, observation.was_offline,
                      member.display_name AS actor,
                      CASE WHEN adoption.observation_id = observation.id THEN 1 ELSE 0 END AS adopted
               FROM leading_passage_observations observation
               JOIN races race ON race.id = observation.race_id
               JOIN course_nodes node ON node.id = observation.course_node_id
               LEFT JOIN marks mark ON mark.id = node.mark_id
               JOIN event_members member ON member.id = observation.recorded_by
               LEFT JOIN leading_passage_adoptions adoption ON adoption.id = (
                 SELECT latest.id FROM leading_passage_adoptions latest
                 WHERE latest.race_id = observation.race_id
                   AND latest.course_node_id = observation.course_node_id
                   AND latest.lap_number = observation.lap_number
                 ORDER BY latest.revision DESC LIMIT 1
               )
               WHERE race.regatta_id = ? AND (? IS NULL OR observation.race_id = ?)
               ORDER BY observation.passed_at DESC LIMIT ?`, values),
    rows(env, `SELECT event.id, event.race_id, race.race_number, event.status,
                      event.revision, event.server_time AS occurred_at,
                      task.title, member.display_name AS actor
               FROM operational_task_events event
               JOIN operational_tasks task ON task.id = event.task_id
               JOIN races race ON race.id = event.race_id
               JOIN event_members member ON member.id = event.member_id
               WHERE race.regatta_id = ? AND (? IS NULL OR event.race_id = ?)
               ORDER BY event.server_time DESC LIMIT ?`, values),
    rows(env, `SELECT message.id, message.race_id, race.race_number,
                      message.sent_at AS occurred_at, message.priority, message.body,
                      message.body_hash, message.deleted_at,
                      member.display_name AS actor, target.label AS target_label,
                      (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = message.id) AS target_count,
                      (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = message.id AND receipt.read_at IS NOT NULL) AS read_count,
                      (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = message.id AND receipt.acknowledged_at IS NOT NULL) AS acknowledged_count
               FROM messages message
               LEFT JOIN races race ON race.id = message.race_id
               JOIN event_members member ON member.id = message.sender_member_id
               LEFT JOIN message_targets target ON target.message_id = message.id
               LEFT JOIN message_receipts permitted
                 ON permitted.message_id = message.id AND permitted.member_id = ?
               WHERE message.regatta_id = ?
                 AND (? IS NULL OR message.race_id = ?)
                 AND (message.sender_member_id = ? OR permitted.message_id IS NOT NULL OR ? = 1)
               ORDER BY message.sent_at DESC LIMIT ?`, messageValues),
    rows(env, `SELECT sample.id, sample.race_id, race.race_number, sample.sampled_at AS occurred_at,
                      sample.lng, sample.lat, sample.speed_knots, sample.course_degrees,
                      boat.name AS actor
               FROM position_samples sample
               JOIN committee_boats boat ON boat.id = sample.committee_boat_id
               LEFT JOIN races race ON race.id = sample.race_id
               WHERE sample.regatta_id = ? AND (? IS NULL OR sample.race_id = ?)
               ORDER BY sample.sampled_at DESC LIMIT ?`, values),
  ])

  const entries: EventLogEntry[] = [
    ...audit.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: number(row.sequence), occurredAt: text(row.occurred_at), category: 'audit' as const,
      title: text(row.action), actor: text(row.actor, 'システム'),
      detail: [text(row.entity_type), text(row.reason)].filter(Boolean).join('・'), eventHash: nullableText(row.event_hash),
    })),
    ...marks.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: number(row.sequence), occurredAt: text(row.occurred_at), category: 'mark' as const,
      title: `${text(row.label)}：${text(row.event_type)}`, actor: text(row.actor, '不明'),
      detail: `位置 ${coordinates(row)}`, eventHash: null,
    })),
    ...wind.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'wind' as const, title: '風向風速観測',
      actor: text(row.actor, '不明'),
      detail: `${row.direction_degrees}°・${row.speed_knots}kt${row.gust_knots == null ? '' : `・ガスト${row.gust_knots}kt`}`,
      eventHash: null,
    })),
    ...signals.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'signal' as const,
      title: signalTitle(text(row.signal_type)), actor: text(row.actor, '不明'),
      detail: signalDetail(row), eventHash: null,
    })),
    ...passages.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'passage' as const,
      title: `先頭艇 ${text(row.label, 'マーク')}通過`, actor: text(row.actor, '不明'),
      detail: `${row.lap_number}周目・${row.adopted ? '採用済' : '観測候補'}・同期 ${text(row.sync_quality)}${row.was_offline ? '・オフライン' : ''}`, eventHash: null,
    })),
    ...tasks.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'task' as const,
      title: text(row.title), actor: text(row.actor, '不明'),
      detail: `${taskStatus(text(row.status))}・第${row.revision}版`, eventHash: null,
    })),
    ...messages.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'message' as const,
      title: text(row.body), actor: text(row.actor, '不明'),
      detail: `${row.deleted_at ? `本文削除 ${text(row.deleted_at)}・` : ''}宛先 ${text(row.target_label, '大会全体')}・優先度 ${text(row.priority)}・既読 ${row.read_count}/${row.target_count}・確認 ${row.acknowledged_count}/${row.target_count}${row.body_hash ? `・本文ハッシュ ${text(row.body_hash)}` : ''}`,
      eventHash: null,
    })),
    ...positions.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'position' as const,
      title: `${text(row.actor)} 位置サンプル`, actor: text(row.actor, '不明'),
      detail: `位置 ${coordinates(row)}・${row.speed_knots ?? '—'}kt・${row.course_degrees ?? '—'}°`, eventHash: null,
    })),
  ]
  return entries.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, limit)
}

export async function handleLogRequest(request: Request, env: AppEnv): Promise<Response | null> {
  if (request.method !== 'GET') return null
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/api\/events\/([^/]+)\/logs$/)
  if (!match) return null
  const session = await requireSession(request, env)
  const access = await eventAccess(env, decodeURIComponent(match[1]), session.userId, session.displayName)
  if (!access) return json({ error: 'Event access denied' }, { status: 403 })
  requirePermission(access, 'view')

  const raceId = url.searchParams.get('raceId') || null
  if (raceId) {
    const race = await env.DB.prepare('SELECT id FROM races WHERE id = ? AND regatta_id = ? LIMIT 1')
      .bind(raceId, access.eventId).first<{ id: string }>()
    if (!race) return json({ error: 'Race not found' }, { status: 404 })
  }
  const format = url.searchParams.get('format') ?? 'json'
  const exportMode = format === 'csv' || url.searchParams.get('download') === '1'
  const requestedLimit = Number(url.searchParams.get('limit') ?? 250)
  const limit = exportMode
    ? 2_500
    : Number.isFinite(requestedLimit) ? Math.min(500, Math.max(25, Math.trunc(requestedLimit))) : 250
  const entries = await collectLogs(env, access, raceId, limit)
  const filename = `${access.eventSlug}-${raceId ? 'race' : 'event'}-log`
  if (format === 'csv') {
    return new Response(eventLogsToCsv(entries), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}.csv"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }
  return json({
    format: 'srs-event-log',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    event: { id: access.eventId, slug: access.eventSlug, name: access.eventName },
    raceId,
    entries,
  }, exportMode ? { headers: { 'content-disposition': `attachment; filename="${filename}.json"` } } : {})
}
