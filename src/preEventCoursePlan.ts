import type { CourseMark } from './domain'
import type { EventCreationPlan } from './eventClient'
import {
  destinationPoint,
  generateCoursePlan,
  recommendedStartLineLength,
  type CourseTemplate,
} from './course'

function shortMarkLabel(label: string): string {
  if (label === 'スタート・ピン') return 'PIN'
  if (label === 'シグナルボート') return 'RC'
  return label
    .replace('オフセット ', '')
    .replace('下ゲート ', '')
    .replace('内側ゲート ', '')
    .replace('中ゲート ', '')
    .replace('上ゲート ', '')
    .replace('マーク', '')
    .trim()
}

export function buildPreEventCourseMarks(plan: EventCreationPlan): CourseMark[] {
  const courseCode = plan.courseCode as CourseTemplate
  const lineLength = recommendedStartLineLength(plan.targetLengthMetres, courseCode)
  const pin = destinationPoint(plan.signalBoatPosition, lineLength, plan.windDirection - 90)
  return generateCoursePlan({
    center: plan.signalBoatPosition,
    startLine: { pin, signal: plan.signalBoatPosition },
    windDirection: plan.windDirection,
    totalLengthMetres: plan.targetLengthMetres,
    courseCode,
    className: plan.className,
    lowerGate: plan.lowerGate,
    upperGate: false,
  }).map((node) => ({
    id: `preview-${node.key}`,
    label: node.label,
    shortLabel: shortMarkLabel(node.label),
    target: node.target,
    status: 'planned' as const,
    isGate: node.nodeType === 'gate',
    gateSide: node.label.endsWith('S') ? 'S' as const : node.label.endsWith('P') ? 'P' as const : undefined,
  }))
}
