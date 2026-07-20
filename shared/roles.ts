export type OperationPermission =
  | 'view'
  | 'position'
  | 'wind'
  | 'current'
  | 'mark'
  | 'leading-passage'
  | 'finish'
  | 'task'
  | 'message'
  | 'signal'
  | 'schedule'
  | 'course'
  | 'assignment'
  | 'finalize'
  | 'post-finalization-revision'

const ROLE_PERMISSIONS: Readonly<Record<string, ReadonlySet<OperationPermission>>> = {
  pro: new Set(['view', 'position', 'wind', 'current', 'mark', 'leading-passage', 'finish', 'task', 'message', 'signal', 'schedule', 'course', 'finalize']),
  ro: new Set(['view', 'position', 'wind', 'current', 'mark', 'leading-passage', 'finish', 'task', 'message', 'signal', 'schedule', 'course', 'finalize']),
  'course-setter': new Set(['view', 'position', 'wind', 'current', 'mark', 'leading-passage', 'task', 'message', 'course']),
  'signal-boat': new Set(['view', 'position', 'wind', 'current', 'leading-passage', 'finish', 'task', 'message', 'signal']),
  'mark-boat': new Set(['view', 'position', 'wind', 'current', 'mark', 'leading-passage', 'task', 'message']),
  timekeeper: new Set(['view', 'leading-passage', 'finish', 'task', 'message']),
  'record-keeper': new Set(['view', 'leading-passage', 'finish', 'task', 'message']),
  'safety-boat': new Set(['view', 'position', 'wind', 'current', 'task', 'message']),
  jury: new Set(['view', 'position', 'leading-passage', 'task', 'message']),
  protest: new Set(['view', 'position', 'leading-passage', 'task', 'message']),
  viewer: new Set(['view']),
}

const ROLE_ALIASES: Readonly<Record<string, string>> = {
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
  '閲覧者': 'viewer',
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: '大会管理者',
  pro: 'PRO',
  ro: 'RO',
  'course-setter': 'コースセッター',
  'signal-boat': 'シグナルボート',
  'mark-boat': 'マークボート',
  timekeeper: 'タイムキーパー',
  'record-keeper': '記録員',
  'safety-boat': '安全ボート',
  jury: 'ジュリー',
  protest: 'プロテスト',
  viewer: '閲覧者',
}

export const INVITABLE_OPERATION_ROLES = [
  'mark-boat',
  'signal-boat',
  'course-setter',
  'timekeeper',
  'record-keeper',
  'safety-boat',
  'jury',
  'protest',
  'pro',
  'ro',
  'viewer',
] as const

export function normalizeOperationRole(role: string): string {
  const value = role.trim().toLowerCase()
  return ROLE_ALIASES[value] ?? value
}

export function roleCan(role: string, permission: OperationPermission): boolean {
  return ROLE_PERMISSIONS[normalizeOperationRole(role)]?.has(permission) ?? false
}

export function operationRoleLabel(role: string): string {
  const normalized = normalizeOperationRole(role)
  return ROLE_LABELS[normalized] ?? role
}

export function isRaceOfficerRole(role: string): boolean {
  return ['pro', 'ro'].includes(normalizeOperationRole(role))
}

export function canRecordOverallWind(role: string): boolean {
  const normalized = normalizeOperationRole(role)
  return roleCan(normalized, 'course') || ['signal-boat', 'safety-boat'].includes(normalized)
}

export function isInvitableOperationRole(role: string): boolean {
  return (INVITABLE_OPERATION_ROLES as readonly string[]).includes(normalizeOperationRole(role))
}
