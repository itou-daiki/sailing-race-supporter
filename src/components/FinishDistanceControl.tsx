import {
  MAX_CUSTOM_FINISH_DISTANCE_NM,
  MIN_CUSTOM_FINISH_DISTANCE_NM,
  WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES,
  WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_NM,
  isValidCustomFinishDistanceMetres,
  nauticalMilesToMetres,
  type FinishDistanceMode,
} from '../../shared/finishDistance'

interface FinishDistanceControlProps {
  mode: FinishDistanceMode
  customNauticalMiles: string
  disabled?: boolean
  onModeChange: (mode: FinishDistanceMode) => void
  onCustomNauticalMilesChange: (value: string) => void
}

export function FinishDistanceControl({
  mode,
  customNauticalMiles,
  disabled = false,
  onModeChange,
  onCustomNauticalMilesChange,
}: FinishDistanceControlProps) {
  const customValue = Number(customNauticalMiles)
  const customMetres = Number.isFinite(customValue) ? Math.round(nauticalMilesToMetres(customValue)) : undefined
  const customValid = customMetres !== undefined && isValidCustomFinishDistanceMetres(nauticalMilesToMetres(customValue))

  return (
    <section className="finish-distance-control" aria-label="3マークからフィニッシュまでの距離">
      <div className="finish-distance-control__heading">
        <strong>3マーク → フィニッシュ</strong>
        <small>トラペゾイドの最終レグ</small>
      </div>
      <div className="finish-distance-control__options" role="radiogroup" aria-label="フィニッシュ距離の決め方">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'world-sailing-standard'}
          className={mode === 'world-sailing-standard' ? 'is-selected' : ''}
          disabled={disabled}
          onClick={() => onModeChange('world-sailing-standard')}
        >
          <strong>標準 0.15 NM</strong>
          <small>約{Math.round(WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES)} m</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'custom'}
          className={mode === 'custom' ? 'is-selected' : ''}
          disabled={disabled}
          onClick={() => onModeChange('custom')}
        >
          <strong>手動で指定</strong>
          <small>海面・練習に合わせる</small>
        </button>
      </div>
      {mode === 'custom' && (
        <label className="finish-distance-control__custom">
          <span>距離</span>
          <span className="finish-distance-control__input">
            <input
              aria-label="3マークからフィニッシュまでの距離"
              type="number"
              inputMode="decimal"
              min={MIN_CUSTOM_FINISH_DISTANCE_NM}
              max={MAX_CUSTOM_FINISH_DISTANCE_NM}
              step="0.01"
              value={customNauticalMiles}
              aria-invalid={!customValid}
              disabled={disabled}
              onChange={(event) => onCustomNauticalMilesChange(event.target.value)}
            />
            <b>NM</b>
          </span>
          <small className={customValid ? undefined : 'is-error'}>
            {customValid
              ? `約${customMetres} m（${MIN_CUSTOM_FINISH_DISTANCE_NM.toFixed(2)}〜${MAX_CUSTOM_FINISH_DISTANCE_NM.toFixed(2)} NM）`
              : `${MIN_CUSTOM_FINISH_DISTANCE_NM.toFixed(2)}〜${MAX_CUSTOM_FINISH_DISTANCE_NM.toFixed(2)} NMの範囲で入力してください`}
          </small>
        </label>
      )}
      <p>
        {mode === 'world-sailing-standard'
          ? `World Sailingのトラペゾイド基準 ${WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_NM.toFixed(2)} NMを使用します。`
          : '入力値は推奨総航程・第1レグ・地図上のFIN–F位置に反映されます。'}
      </p>
    </section>
  )
}
