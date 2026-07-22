import { AlertTriangle, Anchor, CheckCircle2, Compass, LocateFixed, LogIn, MapPinned, Route, Sailboat, Share2, ShieldCheck, Sparkles, Wind } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CLASS_PROFILES,
  type LngLat,
  type SailingClass,
} from '../domain'
import { distanceMetres, firstLegLengthMetresFromTotal, recommendedCourseLength, type CourseTemplate } from '../course'
import { coursePresetForClass, coursePresetsForClass, normalizeCoursePresetCode, type CoursePresetCode } from '../../shared/coursePresets'
import { DEFAULT_RACE_AREA_CENTER } from '../../shared/defaultRaceArea'
import type { EventCreationPlan } from '../eventClient'
import { formatWindSpeedDual } from '../markWind'
import { CoursePreviewMap } from './CoursePreviewMap'
import { buildPreEventCourseMarks } from '../preEventCoursePlan'
import { buildCourseFeatures } from '../mapCourseFeatures'
import { assessCoastClearance, findCoastClearSignalPosition, type CoastClearanceAssessment } from '../coastClearance'
import { buildSharedCourseUrl, sharedCourseFromHash, type SharedCoursePayload } from '../courseShare'

const MINIMUM_COAST_CLEARANCE_METRES = 300
const LOCAL_MARK_POSITIONS_KEY = 'srs:pre-event-mark-positions'

function storedMarkPositions(): Record<string, LngLat> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_MARK_POSITIONS_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, LngLat] => (
      Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every(Number.isFinite)
    )))
  } catch {
    return {}
  }
}

function coursePathForMarks(marks: ReturnType<typeof buildPreEventCourseMarks>, route: readonly string[]): LngLat[] {
  const feature = buildCourseFeatures(marks, route).course.features[0]
  return feature?.geometry.coordinates.map((coordinate) => [coordinate[0], coordinate[1]] as LngLat) ?? []
}

function defaultTargetMinutes(className: SailingClass): number {
  return CLASS_PROFILES.find((profile) => profile.className === className)?.targetMinutes ?? 50
}

interface PreEventCoursePlannerProps {
  onIssueEvent: (plan: EventCreationPlan) => void
  onOpenEvents: () => void
}

export function PreEventCoursePlanner({ onIssueEvent, onOpenEvents }: PreEventCoursePlannerProps) {
  const [importedCourse] = useState(() => (
    typeof window === 'undefined' ? undefined : sharedCourseFromHash(window.location.hash)
  ))
  const importedCourseCode = importedCourse
    ? normalizeCoursePresetCode(importedCourse.className, importedCourse.courseCode)
    : undefined
  const controlsRef = useRef<HTMLElement>(null)
  const [mobileStep, setMobileStep] = useState<'course' | 'position' | 'wind'>('course')
  const [className, setClassName] = useState<SailingClass>(importedCourse?.className ?? '470')
  const [courseCode, setCourseCode] = useState<CoursePresetCode>(importedCourseCode ?? 'O2')
  const [lowerGate, setLowerGate] = useState(importedCourse?.lowerGate ?? true)
  const [finishLineMode, setFinishLineMode] = useState<'separate' | 'shared-rc'>(importedCourse?.finishLineMode ?? 'separate')
  const [longitude, setLongitude] = useState(String(importedCourse?.signalBoatPosition[0] ?? DEFAULT_RACE_AREA_CENTER.longitude))
  const [latitude, setLatitude] = useState(String(importedCourse?.signalBoatPosition[1] ?? DEFAULT_RACE_AREA_CENTER.latitude))
  const [windDirection, setWindDirection] = useState(importedCourse?.windDirection ?? 350)
  const [windSpeed, setWindSpeed] = useState(importedCourse?.windSpeed ?? 8)
  const [distanceBasis, setDistanceBasis] = useState<'target-time' | 'wind-standard'>(importedCourse?.distanceBasis ?? 'target-time')
  const [targetMinutes, setTargetMinutes] = useState(importedCourse?.targetMinutes ?? defaultTargetMinutes(importedCourse?.className ?? '470'))
  const selectedPreset = coursePresetForClass(className, courseCode)
  const standardTargetMinutes = defaultTargetMinutes(className)
  const effectiveTargetMinutes = distanceBasis === 'target-time' ? targetMinutes : standardTargetMinutes
  const recommendation = useMemo(
    () => recommendedCourseLength(className, windSpeed, effectiveTargetMinutes, selectedPreset.code as CourseTemplate, finishLineMode),
    [className, effectiveTargetMinutes, finishLineMode, selectedPreset.code, windSpeed],
  )
  const [courseLengthKm, setCourseLengthKm] = useState(() => importedCourse
    ? (importedCourse.targetLengthMetres / 1_000).toFixed(2)
    : recommendedCourseLength('470', 8, undefined, 'O2').kilometres.toFixed(2))
  const [locationError, setLocationError] = useState<string>()
  const [coastCheck, setCoastCheck] = useState<{ pathKey: string; assessment: CoastClearanceAssessment }>({
    pathKey: '',
    assessment: { status: 'unavailable' },
  })
  const [coastAdjustment, setCoastAdjustment] = useState<string>()
  const [relocatingCourse, setRelocatingCourse] = useState(false)
  const [currentPosition, setCurrentPosition] = useState<LngLat>()
  const [currentPositionAccuracy, setCurrentPositionAccuracy] = useState<number>()
  const [localMarkPositions, setLocalMarkPositions] = useState<Record<string, LngLat>>(() => {
    const stored = storedMarkPositions()
    if (!importedCourse || !importedCourseCode) return stored
    return {
      ...stored,
      ...Object.fromEntries(Object.entries(importedCourse.marks).map(([label, position]) => (
        [`${importedCourseCode}:${label}`, position]
      ))),
    }
  })
  const [selectedMarkId, setSelectedMarkId] = useState<string>()
  const [navigationMarkId, setNavigationMarkId] = useState<string>()
  const [shareStatus, setShareStatus] = useState(importedCourse ? '共有されたコース設定を読み込みました。' : '')
  const coastRequestRef = useRef(0)
  const automaticAdjustmentKeyRef = useRef<string | undefined>(undefined)
  const parsedPosition = useMemo<LngLat | undefined>(() => {
    const lng = Number(longitude)
    const lat = Number(latitude)
    return Number.isFinite(lng) && lng >= -180 && lng <= 180 && Number.isFinite(lat) && lat >= -85 && lat <= 85
      ? [lng, lat]
      : undefined
  }, [latitude, longitude])
  const plan = useMemo<EventCreationPlan>(() => ({
    className,
    courseCode: selectedPreset.code,
    signalBoatPosition: parsedPosition ?? [DEFAULT_RACE_AREA_CENTER.longitude, DEFAULT_RACE_AREA_CENTER.latitude],
    windDirection,
    windSpeed,
    lowerGate,
    finishLineMode,
    targetLengthMetres: Math.max(500, Number(courseLengthKm) * 1_000 || recommendation.kilometres * 1_000),
    targetMinutes: effectiveTargetMinutes,
  }), [className, courseLengthKm, effectiveTargetMinutes, finishLineMode, lowerGate, parsedPosition, recommendation.kilometres, selectedPreset.code, windDirection, windSpeed])
  const marks = useMemo(() => buildPreEventCourseMarks(plan).map((mark) => {
    const recorded = localMarkPositions[`${selectedPreset.code}:${mark.shortLabel}`]
    return recorded ? { ...mark, actual: recorded } : mark
  }), [localMarkPositions, plan, selectedPreset.code])
  const selectedMark = marks.find((mark) => mark.id === selectedMarkId)
  const navigationMark = marks.find((mark) => mark.id === navigationMarkId)
  const navigationDistanceMetres = currentPosition && navigationMark
    ? distanceMetres(currentPosition, navigationMark.actual ?? navigationMark.target)
    : undefined
  const coursePath = useMemo(() => coursePathForMarks(marks, selectedPreset.route), [marks, selectedPreset.route])
  const coursePathKey = useMemo(() => coursePath.map((position) => position.join(',')).join('|'), [coursePath])
  const coastClearance: CoastClearanceAssessment | { status: 'checking' } = coastCheck.pathKey === coursePathKey
    ? coastCheck.assessment
    : { status: 'checking' }
  const enteredTotalKilometres = Math.max(0.5, Number(courseLengthKm) || recommendation.kilometres)
  const plannedFirstLegKilometres = firstLegLengthMetresFromTotal(
    enteredTotalKilometres * 1_000,
    selectedPreset.code as CourseTemplate,
    className,
    windSpeed,
    finishLineMode,
  ) / 1_000
  const canIssueEvent = Boolean(parsedPosition && coastClearance.status === 'safe' && !relocatingCourse)

  const changeClass = (nextClass: SailingClass) => {
    const nextCode = normalizeCoursePresetCode(nextClass, courseCode)
    const preset = coursePresetForClass(nextClass, nextCode)
    setClassName(nextClass)
    setCourseCode(nextCode)
    setLowerGate(preset.route.some((point) => point.includes('S/')))
    const nextMinutes = distanceBasis === 'target-time' ? targetMinutes : defaultTargetMinutes(nextClass)
    setCourseLengthKm(recommendedCourseLength(nextClass, windSpeed, nextMinutes, preset.code as CourseTemplate, finishLineMode).kilometres.toFixed(2))
  }

  const changeCourse = (nextCode: CoursePresetCode) => {
    const preset = coursePresetForClass(className, nextCode)
    setCourseCode(nextCode)
    setLowerGate(preset.route.some((point) => point.includes('S/')))
    setCourseLengthKm(recommendedCourseLength(className, windSpeed, effectiveTargetMinutes, preset.code as CourseTemplate, finishLineMode).kilometres.toFixed(2))
  }

  const changeWindSpeed = (nextSpeed: number) => {
    const normalized = Math.min(40, Math.max(1, nextSpeed))
    setWindSpeed(normalized)
    setCourseLengthKm(recommendedCourseLength(className, normalized, effectiveTargetMinutes, selectedPreset.code as CourseTemplate, finishLineMode).kilometres.toFixed(2))
  }

  const changeFinishLineMode = (nextMode: 'separate' | 'shared-rc') => {
    setFinishLineMode(nextMode)
    setCourseLengthKm(recommendedCourseLength(className, windSpeed, effectiveTargetMinutes, selectedPreset.code as CourseTemplate, nextMode).kilometres.toFixed(2))
  }

  const changeDistanceBasis = (nextBasis: 'target-time' | 'wind-standard') => {
    const nextMinutes = nextBasis === 'target-time' ? targetMinutes : standardTargetMinutes
    setDistanceBasis(nextBasis)
    setCourseLengthKm(recommendedCourseLength(className, windSpeed, nextMinutes, selectedPreset.code as CourseTemplate, finishLineMode).kilometres.toFixed(2))
  }

  const changeTargetMinutes = (nextMinutes: number) => {
    const normalized = Math.min(180, Math.max(15, nextMinutes))
    setTargetMinutes(normalized)
    if (distanceBasis === 'target-time') {
      setCourseLengthKm(recommendedCourseLength(className, windSpeed, normalized, selectedPreset.code as CourseTemplate, finishLineMode).kilometres.toFixed(2))
    }
  }

  const setSignalPosition = useCallback((position: LngLat) => {
    setLongitude(position[0].toFixed(7))
    setLatitude(position[1].toFixed(7))
    setLocalMarkPositions((current) => {
      const key = `${selectedPreset.code}:RC`
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setLocationError(undefined)
  }, [selectedPreset.code])

  const useCurrentLocation = () => {
    setLocationError(undefined)
    if (!navigator.geolocation) {
      setLocationError('この端末では位置情報を利用できません。緯度・経度を直接入力してください。')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next: LngLat = [position.coords.longitude, position.coords.latitude]
        setCurrentPosition(next)
        setCurrentPositionAccuracy(position.coords.accuracy)
        setSignalPosition(next)
      },
      () => setLocationError('現在地を取得できません。緯度・経度を直接入力してください。'),
      { enableHighAccuracy: true, timeout: 12_000 },
    )
  }

  const openMobileStep = (step: 'course' | 'position' | 'wind') => {
    setMobileStep(step)
    if (controlsRef.current) controlsRef.current.scrollTop = 0
  }

  const courseGeometryAtSignalPosition = useCallback((signalBoatPosition: LngLat) => {
    const positionedMarks = buildPreEventCourseMarks({ ...plan, signalBoatPosition })
    return {
      path: coursePathForMarks(positionedMarks, selectedPreset.route),
      additionalPoints: positionedMarks.map((mark) => mark.target),
    }
  }, [plan, selectedPreset.route])

  const relocateCourseOffshore = useCallback(async () => {
    if (!parsedPosition || relocatingCourse) return
    setRelocatingCourse(true)
    setCoastAdjustment(undefined)
    const result = await findCoastClearSignalPosition(
      parsedPosition,
      courseGeometryAtSignalPosition,
      MINIMUM_COAST_CLEARANCE_METRES,
    )
    setRelocatingCourse(false)
    if (result.assessment.status === 'safe' && result.movedMetres > 0) {
      setCoastAdjustment(`陸岸から300m以上確保するため、本船予定位置を沖へ約${Math.round(result.movedMetres)}m移動しました。`)
      setSignalPosition(result.position)
      return
    }
    setCoastCheck({ pathKey: coursePathKey, assessment: result.assessment })
  }, [courseGeometryAtSignalPosition, coursePathKey, parsedPosition, relocatingCourse, setSignalPosition])

  useEffect(() => {
    if (!navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setCurrentPosition([position.coords.longitude, position.coords.latitude])
        setCurrentPositionAccuracy(position.coords.accuracy)
        setLocationError(undefined)
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) setLocationError('現在地の表示には、ブラウザの位置情報を許可してください。')
      },
      { enableHighAccuracy: true, maximumAge: 3_000, timeout: 15_000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  useEffect(() => {
    try {
      if (typeof window.localStorage?.setItem === 'function') {
        window.localStorage.setItem(LOCAL_MARK_POSITIONS_KEY, JSON.stringify(localMarkPositions))
      }
    } catch {
      // Private browsing or embedded browsers may deny storage; the current session still works.
    }
  }, [localMarkPositions])

  useEffect(() => {
    const requestId = ++coastRequestRef.current
    const timer = window.setTimeout(() => {
      void assessCoastClearance(
        coursePath,
        MINIMUM_COAST_CLEARANCE_METRES,
        fetch,
        marks.map((mark) => mark.target),
      ).then((assessment) => {
        if (coastRequestRef.current === requestId) setCoastCheck({ pathKey: coursePathKey, assessment })
      })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [coursePath, coursePathKey, marks])

  useEffect(() => {
    if (coastClearance.status !== 'unsafe' || !parsedPosition || relocatingCourse) return
    const adjustmentKey = [parsedPosition.join(','), selectedPreset.code, windDirection, courseLengthKm, lowerGate, finishLineMode].join('|')
    if (automaticAdjustmentKeyRef.current === adjustmentKey) return
    automaticAdjustmentKeyRef.current = adjustmentKey
    void relocateCourseOffshore()
  }, [coastClearance.status, courseLengthKm, finishLineMode, lowerGate, parsedPosition, relocateCourseOffshore, relocatingCourse, selectedPreset.code, windDirection])

  const coastClearanceDisplay = relocatingCourse
    ? { status: 'checking' as const, label: '300m確保へ沖側に補正中' }
    : coastClearance.status === 'safe'
      ? { status: 'safe' as const, label: '陸岸から300m以上' }
      : coastClearance.status === 'unsafe'
        ? { status: 'unsafe' as const, label: `陸岸まで約${Math.round(coastClearance.minimumMetres)}m` }
        : coastClearance.status === 'unavailable'
          ? { status: 'unavailable' as const, label: '離岸距離を確認できません' }
          : { status: 'checking' as const, label: '陸岸からの距離を確認中' }

  const recordSelectedMarkAtCurrentPosition = () => {
    if (!selectedMark || !currentPosition) {
      setLocationError('現在地を取得してからマークを記録してください。')
      return
    }
    setLocalMarkPositions((current) => ({
      ...current,
      [`${selectedPreset.code}:${selectedMark.shortLabel}`]: currentPosition,
    }))
  }

  const clearSelectedMarkPosition = () => {
    if (!selectedMark) return
    setLocalMarkPositions((current) => {
      const next = { ...current }
      delete next[`${selectedPreset.code}:${selectedMark.shortLabel}`]
      return next
    })
  }

  const shareConfiguredCourse = async () => {
    const payload: SharedCoursePayload = {
      version: 1,
      className,
      courseCode: selectedPreset.code,
      signalBoatPosition: plan.signalBoatPosition,
      windDirection,
      windSpeed,
      lowerGate,
      finishLineMode,
      targetLengthMetres: plan.targetLengthMetres,
      targetMinutes: effectiveTargetMinutes,
      distanceBasis,
      marks: Object.fromEntries(marks.map((mark) => [mark.shortLabel, mark.actual ?? mark.target])),
    }
    const url = buildSharedCourseUrl(window.location.href, payload)
    try {
      if (navigator.share) {
        await navigator.share({ title: `${selectedPreset.displayCode} コース設定`, text: 'Sailing Race Supporter コース設定', url })
        setShareStatus('設定コースを共有しました。')
        return
      }
      if (navigator.clipboard) await navigator.clipboard.writeText(url)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = url
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setShareStatus('設定コースの共有URLをコピーしました。')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setShareStatus('共有できませんでした。もう一度お試しください。')
    }
  }

  return (
    <main className="pre-event-shell">
      <header className="pre-event-header">
        <div className="brand-lockup">
          <span className="brand-mark"><Anchor size={22} /></span>
          <span><strong>Sailing Race Supporter</strong><small>Created by Dit-Lab.（Daiki ITO）</small></span>
        </div>
        <div className="pre-event-header__actions">
          <button type="button" aria-label="参加・作成済みの大会を開く" onClick={onOpenEvents}><LogIn size={17} />参加・作成済みの大会</button>
          <button type="button" aria-label="設定コースを共有" onClick={() => void shareConfiguredCourse()}><Share2 size={17} />設定コースを共有</button>
          <button type="button" className="is-primary" aria-label="大会URLを発行" disabled={!canIssueEvent} onClick={() => onIssueEvent(plan)}><Sailboat size={17} />大会URLを発行</button>
        </div>
      </header>

      <section className="pre-event-intro">
        <span><Sparkles size={18} /></span>
        <div><strong>URLなしでも、現在地確認・マーク設置・ナビが使えます</strong><small>記録したマーク座標はこの端末内に保存されます。大会URLを発行するとリアルタイム共有できます。</small>{shareStatus && <em className="pre-event-share-status" role="status">{shareStatus}</em>}</div>
      </section>

      <div className="pre-event-workspace">
        <aside ref={controlsRef} className="pre-event-controls" aria-label="コース作成条件">
          <div className="pre-event-mobile-overview" aria-label="現在の設定概要">
            <span><small>艇種・コース</small><strong>{className}・{selectedPreset.displayCode}</strong></span>
            <span><small>風</small><strong>{windDirection}°T・{windSpeed.toFixed(1)}kt</strong></span>
            <span><small>第1レグ</small><strong>{plannedFirstLegKilometres.toFixed(2)}km</strong></span>
          </div>

          <nav className="pre-event-mobile-tabs" aria-label="設定する項目">
            <button type="button" aria-current={mobileStep === 'course' ? 'step' : undefined} className={mobileStep === 'course' ? 'is-active' : ''} onClick={() => openMobileStep('course')}><Route size={17} /><span><b>コース</b><small>艇種・ゲート</small></span></button>
            <button type="button" aria-current={mobileStep === 'position' ? 'step' : undefined} className={mobileStep === 'position' ? 'is-active' : ''} onClick={() => openMobileStep('position')}><MapPinned size={17} /><span><b>本部船</b><small>位置</small></span></button>
            <button type="button" aria-current={mobileStep === 'wind' ? 'step' : undefined} className={mobileStep === 'wind' ? 'is-active' : ''} onClick={() => openMobileStep('wind')}><Compass size={17} /><span><b>風・長さ</b><small>推奨値</small></span></button>
          </nav>

          <section className={`pre-event-step-panel ${mobileStep === 'course' ? 'is-mobile-active' : ''}`} data-mobile-panel="course">
            <header><b>1</b><span><strong>艇種とコース</strong><small>分からなければ推奨を選択</small></span></header>
            <div className="pre-event-field-grid">
              <label><span>競技ヨットクラス</span><select value={className} onChange={(event) => changeClass(event.target.value as SailingClass)}>{CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}</select></label>
              <label><span>コース</span><select value={selectedPreset.code} onChange={(event) => changeCourse(event.target.value as CoursePresetCode)}>{coursePresetsForClass(className).map((preset) => <option value={preset.code} key={preset.code}>{preset.optionLabel}{preset.recommended ? '（推奨）' : ''}</option>)}</select></label>
            </div>
            <p className="pre-event-course-summary"><strong>{selectedPreset.displayCode}・{selectedPreset.name}</strong><span>{selectedPreset.route.join(' → ')}</span></p>
            <div className="pre-event-gate" role="radiogroup" aria-label="ゲートマークの有無">
              <span>ゲートマーク</span>
              <button type="button" role="radio" aria-checked={lowerGate} className={lowerGate ? 'is-selected' : ''} onClick={() => setLowerGate(true)}>あり（S・Pの2点）</button>
              <button type="button" role="radio" aria-checked={!lowerGate} className={!lowerGate ? 'is-selected' : ''} onClick={() => setLowerGate(false)}>なし（単一マーク）</button>
            </div>
            <div className="pre-event-gate" role="radiogroup" aria-label="フィニッシュライン方式">
              <span>フィニッシュ</span>
              <button type="button" role="radio" aria-checked={finishLineMode === 'separate'} className={finishLineMode === 'separate' ? 'is-selected' : ''} onClick={() => changeFinishLineMode('separate')}>別に設置（FIN艇＋F）</button>
              <button type="button" role="radio" aria-checked={finishLineMode === 'shared-rc'} className={finishLineMode === 'shared-rc' ? 'is-selected' : ''} onClick={() => changeFinishLineMode('shared-rc')}>本船兼用（RC＋F）</button>
            </div>
            <p className="pre-event-course-summary"><strong>{finishLineMode === 'separate' ? '大会向け・独立フィニッシュ' : '練習向け・FIN艇不要'}</strong><span>{finishLineMode === 'separate' ? '3マークから0.15 NM先に緑のFIN–Fラインを設定します。' : 'RCから風下へFマークを置き、緑のフィニッシュラインを作ります。'}</span></p>
          </section>

          <section className={`pre-event-step-panel ${mobileStep === 'position' ? 'is-mobile-active' : ''}`} data-mobile-panel="position">
            <header><b>2</b><span><strong>本部船の位置</strong><small>風上を向いて右側・スターボード端</small></span></header>
            <button type="button" className="pre-event-location" onClick={useCurrentLocation}><LocateFixed size={16} />スマホの現在地を使う</button>
            <div className="pre-event-field-grid">
              <label><span>経度</span><input aria-label="本部船の経度" type="number" inputMode="decimal" step="0.0000001" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label>
              <label><span>緯度</span><input aria-label="本部船の緯度" type="number" inputMode="decimal" step="0.0000001" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label>
            </div>
            {locationError && <p className="pre-event-error" role="alert">{locationError}</p>}
            <div className={`pre-event-coast-safety is-${coastClearanceDisplay.status}`} role="status">
              <span>{coastClearanceDisplay.status === 'safe' ? <CheckCircle2 size={17} /> : coastClearanceDisplay.status === 'unsafe' || coastClearanceDisplay.status === 'unavailable' ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}</span>
              <div><strong>{coastClearanceDisplay.label}</strong><small>国土地理院データで全レグを確認・海図と現場確認は別途必須</small></div>
              {coastClearance.status === 'unsafe' && !relocatingCourse && <button type="button" onClick={() => void relocateCourseOffshore()}>沖へ自動移動</button>}
            </div>
            {coastAdjustment && <p className="pre-event-coast-adjustment">{coastAdjustment}</p>}
          </section>

          <section className={`pre-event-step-panel ${mobileStep === 'wind' ? 'is-mobile-active' : ''}`} data-mobile-panel="wind">
            <header><b>3</b><span><strong>風向・風速</strong><small>風が吹いてくる方向・真方位</small></span></header>
            <div className="pre-event-gate pre-event-distance-basis" role="radiogroup" aria-label="推奨距離の決め方">
              <span>距離の決め方</span>
              <button type="button" role="radio" aria-checked={distanceBasis === 'target-time'} className={distanceBasis === 'target-time' ? 'is-selected' : ''} onClick={() => changeDistanceBasis('target-time')}>目標時間を優先</button>
              <button type="button" role="radio" aria-checked={distanceBasis === 'wind-standard'} className={distanceBasis === 'wind-standard' ? 'is-selected' : ''} onClick={() => changeDistanceBasis('wind-standard')}>風速から標準距離</button>
            </div>
            <div className="pre-event-field-grid">
              <label><span>風向（°T）</span><input type="number" min="0" max="359" inputMode="numeric" value={windDirection} onChange={(event) => setWindDirection(Math.min(359, Math.max(0, Number(event.target.value))))} /></label>
              <label><span>風速（kt）</span><input type="number" min="1" max="40" step="0.1" inputMode="decimal" value={windSpeed} onChange={(event) => changeWindSpeed(Number(event.target.value))} /></label>
              <label><span>目標レース時間（分）</span><input aria-label="目標レース時間（分）" type="number" min="15" max="180" step="1" inputMode="numeric" value={distanceBasis === 'target-time' ? targetMinutes : standardTargetMinutes} disabled={distanceBasis === 'wind-standard'} onChange={(event) => changeTargetMinutes(Number(event.target.value))} /><small>{distanceBasis === 'target-time' ? 'この時間から推奨距離を逆算' : `${className}の標準 ${standardTargetMinutes}分を使用`}</small></label>
            </div>
            <label className="pre-event-wind-slider"><span><Wind size={15} />{formatWindSpeedDual(windSpeed)}</span><input type="range" min="1" max="25" step="0.5" value={windSpeed} onChange={(event) => changeWindSpeed(Number(event.target.value))} /></label>
          </section>

          <section className={`pre-event-result pre-event-step-panel ${mobileStep === 'wind' ? 'is-mobile-active' : ''}`} data-mobile-panel="wind-result">
            <span>艇種・風速・コース別の推奨第1レグ</span>
            <strong>{recommendation.firstLegKilometres.toFixed(2)} km</strong>
            <small>{recommendation.firstLegNauticalMiles.toFixed(2)} NM・目標時間 {effectiveTargetMinutes}分・{distanceBasis === 'target-time' ? '時間優先' : '風速基準'}</small>
            <dl className="pre-event-speed-breakdown" aria-label="推奨距離の計算内訳">
              <div><dt>クローズVMG</dt><dd>{recommendation.legSpeedsKnots.closeHauledVmg.toFixed(1)} kt <small>{Math.round(recommendation.legDistanceShare.closeHauled * 100)}%</small></dd></div>
              <div><dt>リーチ艇速</dt><dd>{recommendation.legSpeedsKnots.reach.toFixed(1)} kt <small>{Math.round(recommendation.legDistanceShare.reach * 100)}%</small></dd></div>
              <div><dt>フリーVMG</dt><dd>{recommendation.legSpeedsKnots.downwindVmg.toFixed(1)} kt <small>{Math.round(recommendation.legDistanceShare.downwind * 100)}%</small></dd></div>
            </dl>
            <p className="pre-event-total-distance"><span>推定総航程</span><b>{recommendation.kilometres.toFixed(1)} km / {recommendation.nauticalMiles.toFixed(2)} NM</b><small>スタートからフィニッシュまで艇が帆走する概算距離</small></p>
            <label className="pre-event-length"><span>地図に使う推定総航程（km）</span><input type="number" min="0.5" max="30" step="0.01" value={courseLengthKm} onChange={(event) => setCourseLengthKm(event.target.value)} /></label>
            <button type="button" className="pre-event-use-recommendation" onClick={() => setCourseLengthKm(recommendation.kilometres.toFixed(2))}>推奨総航程 {recommendation.kilometres.toFixed(1)} km に戻す</button>
            <button type="button" className="pre-event-share-course" onClick={() => void shareConfiguredCourse()}><Share2 size={18} />この設定コースだけを共有</button>
            <button type="button" disabled={!canIssueEvent} onClick={() => onIssueEvent(plan)}><Sailboat size={18} />この配置を引き継いで大会URLを発行</button>
          </section>
        </aside>

        <CoursePreviewMap
          marks={marks}
          route={selectedPreset.route}
          signalBoatPosition={plan.signalBoatPosition}
          windDirection={windDirection}
          windSpeed={windSpeed}
          finishLineMode={finishLineMode}
          coastClearance={coastClearanceDisplay}
          currentPosition={currentPosition}
          currentPositionAccuracy={currentPositionAccuracy}
          selectedMarkId={selectedMarkId}
          navigationMarkId={navigationMarkId}
          navigationDistanceMetres={navigationDistanceMetres}
          onMarkSelect={(mark) => setSelectedMarkId(mark.id)}
          onCloseMark={() => setSelectedMarkId(undefined)}
          onNavigateToMark={(mark) => setNavigationMarkId(mark.id)}
          onStopNavigation={() => setNavigationMarkId(undefined)}
          onRecordMark={recordSelectedMarkAtCurrentPosition}
          onClearRecordedMark={clearSelectedMarkPosition}
          onSignalBoatPositionChange={setSignalPosition}
        />
      </div>

      <footer className="pre-event-mobile-action">
        <span><small>{className}・{selectedPreset.displayCode}・総航程{enteredTotalKilometres.toFixed(1)}km</small><strong>第1レグ {plannedFirstLegKilometres.toFixed(2)} km</strong></span>
        <button type="button" disabled={!canIssueEvent} onClick={() => onIssueEvent(plan)}><Sailboat size={18} />大会URLを発行</button>
      </footer>
    </main>
  )
}
