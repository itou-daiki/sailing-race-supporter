import { coursePresetForClass, coursePresetsForClass, type CoursePresetCode } from '../../shared/coursePresets'

interface CoursePresetPickerProps {
  className: string
  value: string
  onChange: (courseCode: CoursePresetCode) => void
  label?: string
  disabled?: boolean
}

export function CoursePresetPicker({ className, value, onChange, label = '初期コース', disabled = false }: CoursePresetPickerProps) {
  const presets = coursePresetsForClass(className)
  const selected = coursePresetForClass(className, value)

  return (
    <div className="course-preset-picker">
      <label className="course-preset-select">
        <span>{label}</span>
        <select value={selected.code} disabled={disabled} onChange={(event) => onChange(event.target.value as CoursePresetCode)}>
          {presets.map((preset) => (
            <option value={preset.code} key={preset.code}>
              {preset.optionLabel}{preset.recommended ? '（推奨）' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="course-preset-options" role="radiogroup" aria-label={`${label}の候補`}>
        {presets.map((preset) => (
          <button
            type="button"
            role="radio"
            aria-checked={preset.code === selected.code}
            className={preset.code === selected.code ? 'is-selected' : ''}
            disabled={disabled}
            onClick={() => onChange(preset.code)}
            key={preset.code}
          >
            <strong>{preset.displayCode}</strong>
            <span>{preset.name}<small>{preset.tags.slice(0, 2).join('・')}</small></span>
            {preset.recommended && <em>推奨</em>}
          </button>
        ))}
      </div>

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
