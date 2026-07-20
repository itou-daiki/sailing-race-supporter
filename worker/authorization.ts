import type { AppEnv } from './index.js'
import { normalizeOperationRole, roleCan, type OperationPermission } from '../shared/roles.js'

export type { OperationPermission } from '../shared/roles.js'

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
    role: isOwner ? 'owner' : normalizeOperationRole(row.role ?? 'viewer'),
    assignment: isOwner ? '大会管理者' : row.assignment ?? '',
    isOwner,
  }
}

export function can(access: EventAccess, permission: OperationPermission): boolean {
  if (access.isOwner) return true
  return roleCan(access.role, permission)
}

export function requirePermission(access: EventAccess, permission: OperationPermission): void {
  if (!can(access, permission)) {
    throw new Response('Forbidden', { status: 403 })
  }
}
