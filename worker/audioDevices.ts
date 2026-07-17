import { eventAccess, requirePermission } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, requireSession } from './security.js'

interface AudioDeviceBody {
  action?: 'claim' | 'heartbeat' | 'release'
  deviceId?: string
  deviceLabel?: string
  force?: boolean
  readiness?: {
    audioTested?: boolean
    volumeConfirmed?: boolean
    speakerConfirmed?: boolean
    clockOffsetMs?: number
  }
}

interface AudioDeviceRow {
  race_id: string
  device_id: string
  device_label: string
  member_id: string
  member_name: string
  readiness_json: string
  claimed_at: string
  ready_at: string
  last_seen_at: string
  released_at: string | null
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > maxLength) {
    throw new Response(`${field} is invalid`, { status: 400 })
  }
  return value.trim()
}

async function currentDevice(env: AppEnv, raceId: string): Promise<AudioDeviceRow | null> {
  return env.DB.prepare(
    `SELECT device.*, member.display_name AS member_name
     FROM official_audio_devices device
     JOIN event_members member ON member.id = device.member_id
     WHERE device.race_id = ? AND device.released_at IS NULL LIMIT 1`,
  ).bind(raceId).first<AudioDeviceRow>()
}

function responseDevice(row: AudioDeviceRow | null) {
  if (!row) return null
  return {
    raceId: row.race_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    memberId: row.member_id,
    memberName: row.member_name,
    readiness: JSON.parse(row.readiness_json),
    claimedAt: row.claimed_at,
    readyAt: row.ready_at,
    lastSeenAt: row.last_seen_at,
  }
}

export async function handleAudioDeviceRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/official-audio-device$/)
  if (!match) return null
  const session = await requireSession(request, env)
  const access = await eventAccess(env, decodeURIComponent(match[1]), session.userId, session.displayName)
  if (!access) return json({ error: 'Event access denied' }, { status: 403 })
  const raceId = decodeURIComponent(match[2])
  const race = await env.DB.prepare(
    'SELECT id, status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ id: string; status: string }>()
  if (!race) return json({ error: 'Race not found' }, { status: 404 })

  if (request.method === 'GET') {
    requirePermission(access, 'view')
    return json({ device: responseDevice(await currentDevice(env, raceId)) })
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } })
  assertSameOrigin(request)
  requirePermission(access, 'signal')
  if (race.status === 'finalized') return json({ error: '確定済みレースの公式音響端末は変更できません' }, { status: 409 })
  const body = await readJson<AudioDeviceBody>(request, 8_192)
  const action = body.action
  const deviceId = requiredText(body.deviceId, 'deviceId', 120)
  const now = new Date().toISOString()
  const current = await currentDevice(env, raceId)

  if (action === 'heartbeat') {
    if (!current || current.device_id !== deviceId || current.member_id !== access.memberId) {
      return json({ error: 'この端末は公式音響端末ではありません', device: responseDevice(current) }, { status: 409 })
    }
    await env.DB.prepare(
      'UPDATE official_audio_devices SET last_seen_at = ? WHERE race_id = ? AND device_id = ? AND released_at IS NULL',
    ).bind(now, raceId, deviceId).run()
    return json({ device: responseDevice({ ...current, last_seen_at: now }) })
  }

  if (action === 'release') {
    if (!current) return json({ device: null })
    if (current.device_id !== deviceId && !access.isOwner) {
      return json({ error: '公式音響端末または大会管理者だけが解除できます' }, { status: 403 })
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE official_audio_devices SET released_at = ?, last_seen_at = ? WHERE race_id = ? AND released_at IS NULL')
        .bind(now, now, raceId),
      env.DB.prepare(
        `INSERT INTO official_audio_device_events
         (id, race_id, device_id, device_label, member_id, action, readiness_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'release', ?, ?)`,
      ).bind(crypto.randomUUID(), raceId, current.device_id, current.device_label, access.memberId, current.readiness_json, now),
    ])
    await appendAuditEvent(env, {
      access, raceId, action: 'audio-device.release', entityType: 'official_audio_device',
      entityId: current.device_id, before: responseDevice(current), after: null,
    })
    return json({ device: null })
  }

  if (action !== 'claim') return json({ error: 'Invalid audio device action' }, { status: 400 })
  const deviceLabel = requiredText(body.deviceLabel, 'deviceLabel', 80)
  const readiness = body.readiness
  if (!readiness?.audioTested || !readiness.volumeConfirmed || !readiness.speakerConfirmed) {
    return json({ error: 'テスト音、音量、スピーカーの確認が必要です' }, { status: 400 })
  }
  if (typeof readiness.clockOffsetMs !== 'number' || !Number.isFinite(readiness.clockOffsetMs) || Math.abs(readiness.clockOffsetMs) > 60_000) {
    return json({ error: '端末時刻差を確認できません' }, { status: 400 })
  }
  const takeover = Boolean(current && current.device_id !== deviceId)
  if (takeover && !(body.force && access.isOwner)) {
    return json({ error: `${current?.device_label} が公式音響端末です`, device: responseDevice(current) }, { status: 409 })
  }
  const readinessJson = JSON.stringify(readiness)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO official_audio_devices
       (race_id, device_id, device_label, member_id, readiness_json, claimed_at, ready_at, last_seen_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(race_id) DO UPDATE SET
         device_id = excluded.device_id, device_label = excluded.device_label,
         member_id = excluded.member_id, readiness_json = excluded.readiness_json,
         claimed_at = excluded.claimed_at, ready_at = excluded.ready_at,
         last_seen_at = excluded.last_seen_at, released_at = NULL`,
    ).bind(raceId, deviceId, deviceLabel, access.memberId, readinessJson, now, now, now),
    env.DB.prepare(
      `INSERT INTO official_audio_device_events
       (id, race_id, device_id, device_label, member_id, action, readiness_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), raceId, deviceId, deviceLabel, access.memberId, takeover ? 'takeover' : 'claim', readinessJson, now),
  ])
  const claimed = await currentDevice(env, raceId)
  await appendAuditEvent(env, {
    access, raceId, action: takeover ? 'audio-device.takeover' : 'audio-device.claim',
    entityType: 'official_audio_device', entityId: deviceId,
    before: responseDevice(current), after: responseDevice(claimed),
  })
  return json({ device: responseDevice(claimed) })
}
