import { AlertTriangle, ChevronRight, Compass, LockKeyhole } from 'lucide-react'
import type { OperationalGuidance } from '../operationalGuidance'

interface OperationalCommandBarProps {
  raceLabel: string
  courseLabel: string
  guidance: OperationalGuidance
  onActivate: () => void
}

export function OperationalCommandBar({
  raceLabel,
  courseLabel,
  guidance,
  onActivate,
}: OperationalCommandBarProps) {
  const Icon = guidance.tone === 'warning'
    ? AlertTriangle
    : guidance.tone === 'locked'
      ? LockKeyhole
      : Compass

  return (
    <section className={`operational-command tone-${guidance.tone}`} aria-label="次にやること">
      <span className="operational-command__icon"><Icon size={20} /></span>
      <div className="operational-command__body">
        <span><b>次にやること</b><small>{raceLabel}・{courseLabel}</small></span>
        <strong>{guidance.title}</strong>
        <small>{guidance.reason}</small>
      </div>
      {guidance.actionLabel && (
        <button type="button" onClick={onActivate}>
          <span>{guidance.actionLabel}</span><ChevronRight size={17} />
        </button>
      )}
    </section>
  )
}
