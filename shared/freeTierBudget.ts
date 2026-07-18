export interface CloudflareFreeTierLimits {
  workerRequestsPerDay: number
  durableObjectRequestsPerDay: number
  durableObjectDurationGbSecondsPerDay: number
  durableObjectRowsReadPerDay: number
  durableObjectRowsWrittenPerDay: number
  d1RowsReadPerDay: number
  d1RowsWrittenPerDay: number
}

export interface RegattaLoadModel {
  operatingHours: number
  connectedMembers: number
  positionSharingBoats: number
  positionIntervalSeconds: number
  durableObjectSnapshotSeconds: number
  d1PositionSampleSeconds: number
  otherRealtimeMessages: number
  apiRequests: number
  averageD1RowsReadPerApiRequest: number
  operationalEvents: number
  averageD1RowsWrittenPerOperationalEvent: number
  durableObjectActiveMillisecondsPerMessage: number
}

export type BudgetStage = 'normal' | 'observe' | 'warning' | 'protect' | 'critical'

export interface BudgetMetric {
  key: string
  label: string
  estimated: number
  limit: number
  percent: number
  period: '日' | '月'
}

export interface FreeTierBudgetEstimate {
  generatedFrom: 'standard-regatta-load-model'
  maxPercent: number
  stage: BudgetStage
  limitingMetric: BudgetMetric
  metrics: BudgetMetric[]
  positionMessages: number
}

export interface FreeTierProtectionPolicy {
  stage: BudgetStage
  transientPositionMinIntervalMs: number
  durableObjectPositionSnapshotMs: number
  d1PositionSampleMs: number
  preservesOperationalEvents: true
}

export interface RuntimeBudgetStatus {
  source: 'app-observed-plus-standard-model'
  day: string
  maxPercent: number
  targetPercent: 70
  stage: BudgetStage
  limitingMetricKey: string
  limitingMetricLabel: string
  observedDurableObjectRowsWritten: number
  durableObjectRowsWrittenLimit: number
  policy: FreeTierProtectionPolicy
}

export const DURABLE_OBJECT_POSITION_SNAPSHOT_MS = 30_000
export const ROOM_SEQUENCE_ALLOCATION_SIZE = 1_000

/** Official Workers Free values rechecked against Cloudflare documentation in July 2026. */
export const DEFAULT_CLOUDFLARE_FREE_LIMITS: CloudflareFreeTierLimits = {
  workerRequestsPerDay: 100_000,
  durableObjectRequestsPerDay: 100_000,
  durableObjectDurationGbSecondsPerDay: 13_000,
  durableObjectRowsReadPerDay: 5_000_000,
  durableObjectRowsWrittenPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
}

export const STANDARD_REGATTA_LOAD: RegattaLoadModel = {
  operatingHours: 8,
  connectedMembers: 200,
  positionSharingBoats: 50,
  positionIntervalSeconds: 2,
  durableObjectSnapshotSeconds: DURABLE_OBJECT_POSITION_SNAPSHOT_MS / 1_000,
  d1PositionSampleSeconds: 60,
  otherRealtimeMessages: 2_000,
  apiRequests: 5_000,
  averageD1RowsReadPerApiRequest: 60,
  operationalEvents: 1_500,
  averageD1RowsWrittenPerOperationalEvent: 2,
  durableObjectActiveMillisecondsPerMessage: 20,
}

export function budgetStage(percent: number): BudgetStage {
  if (percent >= 95) return 'critical'
  if (percent >= 85) return 'protect'
  if (percent >= 70) return 'warning'
  if (percent >= 50) return 'observe'
  return 'normal'
}

export function freeTierProtectionPolicy(stage: BudgetStage): FreeTierProtectionPolicy {
  if (stage === 'critical') {
    return {
      stage,
      transientPositionMinIntervalMs: 10_000,
      durableObjectPositionSnapshotMs: 300_000,
      d1PositionSampleMs: 600_000,
      preservesOperationalEvents: true,
    }
  }
  if (stage === 'protect') {
    return {
      stage,
      transientPositionMinIntervalMs: 5_000,
      durableObjectPositionSnapshotMs: 120_000,
      d1PositionSampleMs: 300_000,
      preservesOperationalEvents: true,
    }
  }
  if (stage === 'warning') {
    return {
      stage,
      transientPositionMinIntervalMs: 3_000,
      durableObjectPositionSnapshotMs: 60_000,
      d1PositionSampleMs: 120_000,
      preservesOperationalEvents: true,
    }
  }
  return {
    stage,
    transientPositionMinIntervalMs: 0,
    durableObjectPositionSnapshotMs: DURABLE_OBJECT_POSITION_SNAPSHOT_MS,
    d1PositionSampleMs: 60_000,
    preservesOperationalEvents: true,
  }
}

function metric(
  key: string,
  label: string,
  estimated: number,
  limit: number,
  period: BudgetMetric['period'] = '日',
): BudgetMetric {
  return { key, label, estimated, limit, percent: limit > 0 ? estimated / limit * 100 : 100, period }
}

export function estimateRegattaFreeTierUsage(
  model: RegattaLoadModel,
  limits: CloudflareFreeTierLimits = DEFAULT_CLOUDFLARE_FREE_LIMITS,
): FreeTierBudgetEstimate {
  const operatingSeconds = model.operatingHours * 3_600
  const positionMessages = model.positionSharingBoats * Math.ceil(operatingSeconds / model.positionIntervalSeconds)
  const realtimeMessages = positionMessages + model.otherRealtimeMessages
  const sequenceAllocationWrites = Math.ceil(realtimeMessages / ROOM_SEQUENCE_ALLOCATION_SIZE)
  const durableObjectSnapshotWrites = model.positionSharingBoats * Math.ceil(
    operatingSeconds / model.durableObjectSnapshotSeconds,
  )
  const d1PositionWrites = model.positionSharingBoats * Math.ceil(
    operatingSeconds / model.d1PositionSampleSeconds,
  )
  const durableObjectDurationGbSeconds = realtimeMessages *
    (model.durableObjectActiveMillisecondsPerMessage / 1_000) * 0.125

  const metrics = [
    metric('worker-requests', 'Workers動的リクエスト', model.connectedMembers + model.apiRequests, limits.workerRequestsPerDay),
    metric('do-requests', 'Durable Objectsリクエスト換算', model.connectedMembers + Math.ceil(realtimeMessages / 20), limits.durableObjectRequestsPerDay),
    metric('do-duration', 'Durable Objects稼働時間', durableObjectDurationGbSeconds, limits.durableObjectDurationGbSecondsPerDay),
    metric('do-rows-read', 'Durable Objects行読取', positionMessages, limits.durableObjectRowsReadPerDay),
    metric(
      'do-rows-written',
      'Durable Objects行書込',
      durableObjectSnapshotWrites + model.otherRealtimeMessages + sequenceAllocationWrites,
      limits.durableObjectRowsWrittenPerDay,
    ),
    metric('d1-rows-read', 'D1行読取', model.apiRequests * model.averageD1RowsReadPerApiRequest, limits.d1RowsReadPerDay),
    metric(
      'd1-rows-written',
      'D1行書込',
      d1PositionWrites + model.operationalEvents * model.averageD1RowsWrittenPerOperationalEvent,
      limits.d1RowsWrittenPerDay,
    ),
  ]
  const limitingMetric = metrics.reduce((highest, candidate) => candidate.percent > highest.percent ? candidate : highest)
  return {
    generatedFrom: 'standard-regatta-load-model',
    maxPercent: limitingMetric.percent,
    stage: budgetStage(limitingMetric.percent),
    limitingMetric,
    metrics,
    positionMessages,
  }
}

export function runtimeBudgetStatus(
  day: string,
  observedDurableObjectRowsWritten: number,
  limits: CloudflareFreeTierLimits = DEFAULT_CLOUDFLARE_FREE_LIMITS,
  designEstimate: FreeTierBudgetEstimate = estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD, limits),
): RuntimeBudgetStatus {
  const observedPercent = limits.durableObjectRowsWrittenPerDay > 0
    ? observedDurableObjectRowsWritten / limits.durableObjectRowsWrittenPerDay * 100
    : 100
  const observedIsLimiting = observedPercent >= designEstimate.maxPercent
  const maxPercent = Math.max(observedPercent, designEstimate.maxPercent)
  const stage = budgetStage(maxPercent)
  return {
    source: 'app-observed-plus-standard-model',
    day,
    maxPercent,
    targetPercent: 70,
    stage,
    limitingMetricKey: observedIsLimiting ? 'observed-do-rows-written' : designEstimate.limitingMetric.key,
    limitingMetricLabel: observedIsLimiting
      ? 'Durable Objects行書込（アプリ実測）'
      : `${designEstimate.limitingMetric.label}（標準負荷試算）`,
    observedDurableObjectRowsWritten,
    durableObjectRowsWrittenLimit: limits.durableObjectRowsWrittenPerDay,
    policy: freeTierProtectionPolicy(stage),
  }
}
