import { coursePresetForClass, coursePresetsForClass, type CoursePresetCode } from '../../shared/coursePresets'

interface CoursePresetPickerProps {
  className: string
  value: string
  onChange: (courseCode: CoursePresetCode) => void
  label?: string
}

export function CoursePresetPicker({ className, value, onChange, label = '初期コース' }: CoursePresetPickerProps) {
  const presets = coursePresetsForClass(className)
  const selected = coursePresetForClass(className, value)

  return (
    <div className="course-preset-picker">
      <label className="course-preset-select">
        <span>{label}</span>
        <select value={selected.code} onChange={(event) => onChange(event.target.value as CoursePresetCode)}>
          {presets.map((preset) => (
            <option value={preset.code} key={preset.code}>
              {preset.optionLabel}{preset.recommended ? '（推奨）' : ''}
            </option>
          ))}
        </select>
      </label>

      <section className="course-preset-preview" aria-live="polite">
        <header>
          <b>{selected.displayCode}</b>
          <span>
            <strong>{selected.optionLabel}</strong>
            <small>{selected.codeMeaning}</small>
          </span>
          {selected.recommended && <em>推奨</em>}
        </header>
        <p>{selected.description}</p>
        <div className="course-preset-tags">
          {selected.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        <div className="course-route" aria-label={`標準回航順序：${selected.route.join('、')}`}>
          <small>標準回航順序</small>
          <ol>
            {selected.route.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}
          </ol>
        </div>
        <footer>
          <span>{selected.sourceLabel}</span>
          <small>標準例です。大会の帆走指示書（SI）を優先し、発行後はレースごとに変更できます。</small>
        </footer>
      </section>
    </div>
  )
}
