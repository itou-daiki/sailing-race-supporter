import type { CourseMark } from './domain'
import type { EventCreationPlan } from './eventClient'
import { shortCourseMarkLabel } from './courseMarkLabels'
import {
  destinationPoint,
  generateCoursePlan,
  recommendedStartLineLength,
  type CourseTemplate,
} from './course'

export function buildPreEventCourseMarks(plan: EventCreationPlan): CourseMark[] {
  const courseCode = plan.courseCode as CourseTemplate
  const lineLength = recommendedStartLineLength(plan.targetLengthMetres, courseCode, plan.className, plan.windSpeed, plan.finishLineMode)
  const pin = destinationPoint(plan.signalBoatPosition, lineLength, plan.windDirection - 90)
  return generateCoursePlan({
    center: plan.signalBoatPosition,
    startLine: { pin, signal: plan.signalBoatPosition },
    windDirection: plan.windDirection,
    windSpeed: plan.windSpeed,
    totalLengthMetres: plan.targetLengthMetres,
    courseCode,
    className: plan.className,
    lowerGate: plan.lowerGate,
    upperGate: false,
    finishLineMode: plan.finishLineMode,
  }).map((node) => ({
    id: `preview-${node.key}`,
    label: node.label,
    shortLabel: shortCourseMarkLabel(node.label),
    target: node.target,
    status: 'planned' as const,
    isGate: node.nodeType === 'gate',
    gateSide: node.label.endsWith('S') ? 'S' as const : node.label.endsWith('P') ? 'P' as const : undefined,
  }))
}
