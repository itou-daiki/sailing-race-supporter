import type { AppEnv } from './index.js'

export type OperationPermission =
  | 'view'
  | 'position'
  | 'wind'
  | 'mark'
  | 'leading-passage'
  | 'finish'
  | 'task'
  | 'message'
  | 'signal'
  | 'finalize'
  | 'post-finalization-revision'

export interface EventAccess {
  eventId: string
  eventSlug: string
  eventName: string
  userId: string
  memberId: string
  displayName: string
  role: string
  assignment: string
  isOwner: boolean
}

interface AccessRow {
  event_id: string
  event_slug: string
  event_name: string
  owner_user_id: string
  member_id: string | null
  member_name: string | null
  role: string | null
  assignment: string | null
  member_status: string | null
}

const ALL_OPERATIONS = new Set<OperationPermission>([
  'view',
  'position',
  'wind',
  'mark',
  'leading-passage',
  'finish',
  'task',
  'message',
  'signal',
  'finalize',
  'post-finalization-revision',
])

const ROLE_PERMISSIONS: Readonly<Record<string, ReadonlySet<OperationPermission>>> = {
  pro: new Set(['view', 'position', 'wind', 'mark', 'leading-passage', 'finish', 'task', 'message', 'signal', 'finalize']),
  ro: new Set(['view', 'position', 'wind', 'mark', 'leading-passage', 'finish', 'task', 'message', 'signal', 'finalize']),
  'course-setter': new Set(['view', 'position', 'wind', 'mark', 'leading-passage', 'task', 'message']),
  'signal-boat': new Set(['view', 'position', 'wind', 'leading-passage', 'finish', 'task', 'message', 'signal']),
  'mark-boat': new Set(['view', 'position', 'wind', 'mark', 'leading-passage', 'task', 'message']),
  timekeeper: new Set(['view', 'leading-passage', 'finish', 'task', 'message', 'signal']),
  'record-keeper': new Set(['view', 'leading-passage', 'finish', 'task', 'message']),
  'safety-boat': new Set(['view', 'position', 'wind', 'task', 'message']),
  jury: new Set(['view', 'position', 'leading-passage', 'task', 'message']),
  protest: new Set(['view', 'position', 'leading-passage', 'task', 'message']),
  viewer: new Set(['view']),
}

function normalizeRole(role: string): string {
  const value = role.trim().toLowerCase()
  const aliases: Record<string, string> = {
    '大会管理者': 'owner',
    '管理者': 'owner',
    'コースセッター': 'course-setter',
    'シグナルボート': 'signal-boat',
    '本部船': 'signal-boat',
    'マークボート': 'mark-boat',
    'タイムキーパー': 'timekeeper',
    '記録員': 'record-keeper',
    '安全ボート': 'safety-boat',
    'ジュリー': 'jury',
    'プロテスト': 'protest',
    '閲覧': 'viewer',
  }
  return aliases[value] ?? value
}

export async function eventAccess(
  env: AppEnv,
  eventReference: string,
  userId: string,
  displayName: string,
): Promise<EventAccess | null> {
  const row = await env.DB.prepare(
    `SELECT
       r.id AS event_id,
       r.slug AS event_slug,
       r.name AS event_name,
       r.owner_user_id,
       em.id AS member_id,
       em.display_name AS member_name,
       em.role,
       em.assignment,
       em.status AS member_status
     FROM regattas r
     LEFT JOIN event_members em
       ON em.regatta_id = r.id AND em.user_id = ? AND em.status = 'active'
     WHERE r.id = ? OR r.slug = ?
     LIMIT 1`,
  ).bind(userId, eventReference, eventReference).first<AccessRow>()
  if (!row) return null
  const isOwner = row.owner_user_id === userId
  if (!isOwner && (!row.member_id || row.member_status !== 'active')) return null

  return {
    eventId: row.event_id,
    eventSlug: row.event_slug,
    eventName: row.event_name,
    userId,
    memberId: isOwner ? row.member_id ?? `owner:${userId}` : row.member_id as string,
    displayName: row.member_name ?? displayName,
    role: isOwner ? 'owner' : normalizeRole(row.role ?? 'viewer'),
    assignment: isOwner ? '大会管理者' : row.assignment ?? '',
    isOwner,
  }
}

export function can(access: EventAccess, permission: OperationPermission): boolean {
  if (access.isOwner) return ALL_OPERATIONS.has(permission)
  return ROLE_PERMISSIONS[normalizeRole(access.role)]?.has(permission) ?? false
}

export function requirePermission(access: EventAccess, permission: OperationPermission): void {
  if (!can(access, permission)) {
    throw new Response('Forbidden', { status: 403 })
  }
}
