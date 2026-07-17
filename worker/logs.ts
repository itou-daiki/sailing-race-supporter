import { eventAccess, requirePermission } from './authorization.js'
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
    postpone: '延期', resume: '延期解除', recall: 'リコール', abandon: '中止', shorten: 'コース短縮',
  }
  return labels[type] ?? type
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

async function collectLogs(env: AppEnv, regattaId: string, raceId: string | null, limit: number): Promise<EventLogEntry[]> {
  const values = [regattaId, raceId, raceId, limit]
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
                      COALESCE(member.display_name, '不明') AS actor
               FROM signal_events event
               JOIN races race ON race.id = event.race_id
               LEFT JOIN event_members member ON member.id = event.member_id
               WHERE race.regatta_id = ? AND (? IS NULL OR event.race_id = ?)
               ORDER BY event.executed_at DESC LIMIT ?`, values),
    rows(env, `SELECT passage.id, passage.race_id, race.race_number, passage.passed_at AS occurred_at,
                      passage.lap_number, mark.label, passage.source,
                      member.display_name AS actor
               FROM leading_passage_events passage
               JOIN races race ON race.id = passage.race_id
               JOIN course_nodes node ON node.id = passage.course_node_id
               LEFT JOIN marks mark ON mark.id = node.mark_id
               JOIN event_members member ON member.id = passage.recorded_by
               WHERE race.regatta_id = ? AND (? IS NULL OR passage.race_id = ?)
               ORDER BY passage.passed_at DESC LIMIT ?`, values),
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
                      member.display_name AS actor
               FROM messages message
               LEFT JOIN races race ON race.id = message.race_id
               JOIN event_members member ON member.id = message.sender_member_id
               WHERE message.regatta_id = ?
                 AND (? IS NULL OR message.race_id = ?)
               ORDER BY message.sent_at DESC LIMIT ?`, values),
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
      detail: row.scheduled_at ? `予定 ${text(row.scheduled_at)}` : '実行記録', eventHash: null,
    })),
    ...passages.map((row) => ({
      id: text(row.id), raceId: nullableText(row.race_id), raceNumber: nullableText(row.race_number),
      sequence: null, occurredAt: text(row.occurred_at), category: 'passage' as const,
      title: `先頭艇 ${text(row.label, 'マーク')}通過`, actor: text(row.actor, '不明'),
      detail: `${row.lap_number}周目・${text(row.source)}`, eventHash: null,
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
      detail: `${row.deleted_at ? `本文削除 ${text(row.deleted_at)}・` : ''}優先度 ${text(row.priority)}${row.body_hash ? `・本文ハッシュ ${text(row.body_hash)}` : ''}`,
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
  const entries = await collectLogs(env, access.eventId, raceId, limit)
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
