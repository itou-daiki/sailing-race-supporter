import {
  AlertTriangle,
  Anchor,
  BadgeCheck,
  CircleCheckBig,
  CloudOff,
  Crosshair,
  ChevronDown,
  LocateFixed,
  MapPin,
  Navigation,
  PencilLine,
  Radio,
  Timer,
  Waves,
  Wind,
} from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { bearingDegrees, distanceMetres, estimateEtaSeconds, formatDistance, headingDifferenceDegrees } from '../course'
import type { CommitteeBoat, CourseMark, CurrentObservation, LeadingPassageVisit, LngLat, WindObservation } from '../domain'
import { buildCourseFeatures, findGatePairs } from '../mapCourseFeatures'
import { passageVisitKey } from '../passages'
import {
  decimalMinuteTailParts,
  decimalTailParts,
  positionFromDecimalMinuteTails,
  positionFromDecimalTails,
  positionFromFullDecimal,
  type CoordinateEntryMode,
} from '../coordinateEntry'
import { formatTrueBearing } from '../../shared/trueBearing'
import { GSI_MAP_STYLE } from '../mapStyle'

interface MapViewProps {
  marks: readonly CourseMark[]
  boats: readonly CommitteeBoat[]
  wind: WindObservation
  current: CurrentObservation
  selectedMarkId?: string
  onSelectMark: (markId?: string) => void
  onUseCurrentLocation: (position: LngLat, motion: { speedKnots?: number; courseDegrees?: number; accuracyMetres?: number }) => void
  onRecordDrop: (markId: string) => void
  onRecordManualPosition: (
    markId: string,
    position: LngLat,
    metadata: { entryMode: CoordinateEntryMode; accuracyMetres?: number; note?: string },
  ) => void
  onRecordConfirmation: (markId: string) => void
  onRecordRecovery: (markId: string) => void
  onRecordLeadingPassage: (markId: string) => void
  onAdoptLeadingPassage: (markId: string, observationId: string) => void
  leadingPassages: Readonly<Record<string, LeadingPassageVisit>>
  raceId: string
  raceAreaName?: string
  locked: boolean
  canVerifyMarks: boolean
  manageableMarkIds: readonly string[]
  canEditFinalizedPosition: boolean
  passageLocked: boolean
  canAdoptLeadingPassage: boolean
}

const DATUM_CONFIRMATION_ERROR = 'ハンディGPSの測地系がWGS 84であることを確認してください'

function markStatusLabel(status: CourseMark['status']): string {
  if (status === 'confirmed') return '確認済'
  if (status === 'deployed') return '投下済'
  if (status === 'recovered') return '回収済'
  if (status === 'planned') return '計画中'
  return '移動中'
}

function formatEta(seconds: number | undefined): string {
  if (seconds === undefined) return 'ETA —（0.5kt未満）'
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return minutes < 60 ? `ETA 約${minutes}分` : `ETA 約${Math.floor(minutes / 60)}時間${minutes % 60}分`
}

function observationAgeSeconds(observedAt: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(observedAt)) / 1_000))
}

function freshnessLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return '時刻不明'
  if (seconds < 60) return `${seconds}秒前`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分前`
  return `${Math.floor(seconds / 3_600)}時間前`
}

export function MapView({
  marks,
  boats,
  wind,
  current,
  selectedMarkId,
  onSelectMark,
  onUseCurrentLocation,
  onRecordDrop,
  onRecordManualPosition,
  onRecordConfirmation,
  onRecordRecovery,
  onRecordLeadingPassage,
  onAdoptLeadingPassage,
  leadingPassages,
  raceId,
  raceAreaName,
  locked,
  canVerifyMarks,
  manageableMarkIds,
  canEditFinalizedPosition,
  passageLocked,
  canAdoptLeadingPassage,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRefs = useRef<maplibregl.Marker[]>([])
  const watchRef = useRef<number | undefined>(undefined)
  const manualEditorRef = useRef<HTMLFormElement>(null)
  const firstTrackingFix = useRef(true)
  const [mapReady, setMapReady] = useState(false)
  const [basemapUnavailable, setBasemapUnavailable] = useState(false)
  const [locationError, setLocationError] = useState<string>()
  const [tracking, setTracking] = useState(false)
  const [expandedMarkId, setExpandedMarkId] = useState<string>()
  const [manualEditorMarkId, setManualEditorMarkId] = useState<string>()
  const [manualEntryMode, setManualEntryMode] = useState<CoordinateEntryMode>('dmm-tail-4')
  const [manualLatitude, setManualLatitude] = useState('')
  const [manualLongitude, setManualLongitude] = useState('')
  const [manualAccuracy, setManualAccuracy] = useState('')
  const [manualNote, setManualNote] = useState('ハンディGPSから転記')
  const [manualDifferenceConfirmed, setManualDifferenceConfirmed] = useState(false)
  const [manualDatumConfirmed, setManualDatumConfirmed] = useState(false)
  const [manualEntryError, setManualEntryError] = useState<string>()
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())
  const features = useMemo(() => buildCourseFeatures(marks), [marks])
  const initialFeaturesRef = useRef(features)
  const selectedMark = marks.find((mark) => mark.id === selectedMarkId)
  const selectedIsStartEndpoint = selectedMark?.label === 'スタート・ピン' || selectedMark?.label === 'シグナルボート'
  const markDetailsExpanded = Boolean(selectedMarkId && expandedMarkId === selectedMarkId)
  const canManageSelectedMark = Boolean(selectedMark && manageableMarkIds.includes(selectedMark.id))
  const selfBoat = boats.find((boat) => boat.isSelf)
  const selectedPassage = selectedMark ? leadingPassages[passageVisitKey(raceId, selectedMark.id, 1)] : undefined
  const selectedPassageObservations = selectedPassage?.observations.filter((observation) => observation.status === 'active') ?? []
  const selectedAdoptedPassage = selectedPassageObservations.find((observation) => observation.id === selectedPassage?.adoptedObservationId)
  const selectedDestination = selectedMark?.actual ?? selectedMark?.target
  const manualReference = selectedMark?.actual ?? selectedMark?.target
  const selectedDistance = selfBoat && selectedDestination ? distanceMetres(selfBoat.position, selectedDestination) : undefined
  const selectedBearing = selfBoat && selectedDestination ? bearingDegrees(selfBoat.position, selectedDestination) : undefined
  const headingDifference = selfBoat?.courseDegrees !== undefined && selectedBearing !== undefined
    ? headingDifferenceDegrees(selfBoat.courseDegrees, selectedBearing)
    : undefined
  const selectedEta = selfBoat && selectedDistance !== undefined ? estimateEtaSeconds(selectedDistance, selfBoat.speedKnots) : undefined
  const selectedGate = selectedMark ? findGatePairs(marks).find((gate) => gate.starboard.id === selectedMark.id || gate.port.id === selectedMark.id) : undefined
  const windAgeSeconds = observationAgeSeconds(wind.observedAt, freshnessNow)
  const currentAgeSeconds = observationAgeSeconds(current.observedAt, freshnessNow)
  const manualPreview = (() => {
    if (!manualReference) return undefined
    try {
      return manualEntryMode === 'decimal-tail-4'
        ? positionFromDecimalTails(manualReference, manualLatitude, manualLongitude)
        : manualEntryMode === 'dmm-tail-4'
          ? positionFromDecimalMinuteTails(manualReference, manualLatitude, manualLongitude)
          : positionFromFullDecimal(manualLatitude, manualLongitude)
    } catch {
      return undefined
    }
  })()
  const manualTargetDifference = selectedMark && manualPreview
    ? distanceMetres(selectedMark.target, manualPreview)
    : undefined
  const manualDatumError = manualEntryError === DATUM_CONFIRMATION_ERROR
  const verificationDifference = selectedMark?.actual && selectedMark.verificationPosition
    ? distanceMetres(selectedMark.actual, selectedMark.verificationPosition)
    : undefined

  useEffect(() => {
    const interval = window.setInterval(() => setFreshnessNow(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: GSI_MAP_STYLE,
      center: [139.465, 35.2857],
      zoom: 13.4,
      minZoom: 6,
      maxZoom: 18,
      attributionControl: false,
      cooperativeGestures: false,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    map.on('error', (event) => {
      const sourceId = 'sourceId' in event ? event.sourceId : undefined
      const message = event.error instanceof Error ? event.error.message : String(event.error ?? '')
      if (sourceId === 'gsi' || message.includes('cyberjapandata.gsi.go.jp')) setBasemapUnavailable(true)
    })
    map.on('sourcedata', (event) => {
      if (event.sourceId === 'gsi' && event.isSourceLoaded) setBasemapUnavailable(false)
    })

    map.on('load', () => {
      map.addSource('course-points', { type: 'geojson', data: initialFeaturesRef.current.points })
      map.addSource('target-links', { type: 'geojson', data: initialFeaturesRef.current.targetLinks })
      map.addSource('course-route', { type: 'geojson', data: initialFeaturesRef.current.course })
      map.addSource('gate-lines', { type: 'geojson', data: initialFeaturesRef.current.gates })
      map.addLayer({
        id: 'gate-width-line',
        type: 'line',
        source: 'gate-lines',
        paint: { 'line-color': '#7b4bb7', 'line-width': 3, 'line-dasharray': [1, 1] },
      })
      map.addLayer({
        id: 'course-route-line',
        type: 'line',
        source: 'course-route',
        paint: {
          'line-color': '#087ee8',
          'line-width': 3,
          'line-opacity': 0.72,
          'line-dasharray': [2, 1.2],
        },
      })
      map.addLayer({
        id: 'gate-center-point',
        type: 'circle',
        source: 'course-points',
        filter: ['==', ['get', 'kind'], 'gate-center'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#7b4bb7',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'target-delta-line',
        type: 'line',
        source: 'target-links',
        paint: { 'line-color': '#e5522d', 'line-width': 2, 'line-dasharray': [1.5, 1.2] },
      })
      map.addLayer({
        id: 'mark-target-ring',
        type: 'circle',
        source: 'course-points',
        filter: ['==', ['get', 'kind'], 'target'],
        paint: {
          'circle-radius': 9,
          'circle-color': 'rgba(255,255,255,0.3)',
          'circle-stroke-color': '#0b6db7',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.9,
        },
      })
      map.addLayer({
        id: 'mark-actual-point',
        type: 'circle',
        source: 'course-points',
        filter: ['==', ['get', 'kind'], 'actual'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#ff7a1a',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'mark-verification-point',
        type: 'circle',
        source: 'course-points',
        filter: ['==', ['get', 'kind'], 'verification'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#16a36f',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'mark-recovery-point',
        type: 'circle',
        source: 'course-points',
        filter: ['==', ['get', 'kind'], 'recovery'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#d6a62d',
          'circle-stroke-color': '#5f4108',
          'circle-stroke-width': 2,
        },
      })
      setMapReady(true)
    })

    return () => {
      markerRefs.current.forEach((marker) => marker.remove())
      markerRefs.current = []
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    ;(map.getSource('course-points') as GeoJSONSource | undefined)?.setData(features.points)
    ;(map.getSource('target-links') as GeoJSONSource | undefined)?.setData(features.targetLinks)
    ;(map.getSource('course-route') as GeoJSONSource | undefined)?.setData(features.course)
    ;(map.getSource('gate-lines') as GeoJSONSource | undefined)?.setData(features.gates)
  }, [features, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    markerRefs.current.forEach((marker) => marker.remove())
    markerRefs.current = boats.map((boat) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = `boat-marker ${boat.isSelf ? 'boat-marker--self' : ''}`
      element.setAttribute('aria-label', `${boat.name} ${boat.assignment}`)
      const direction = document.createElement('span')
      direction.className = boat.courseDegrees === undefined ? 'boat-marker__stationary' : 'boat-marker__arrow'
      direction.textContent = boat.courseDegrees === undefined ? '●' : '▲'
      if (boat.courseDegrees !== undefined) direction.style.transform = `rotate(${boat.courseDegrees}deg)`
      const label = document.createElement('span')
      label.className = 'boat-marker__label'
      label.textContent = boat.assignment
      element.appendChild(direction)
      element.appendChild(label)
      return new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat([...boat.position])
        .addTo(map)
    })

    return () => {
      markerRefs.current.forEach((marker) => marker.remove())
      markerRefs.current = []
    }
  }, [boats, mapReady])

  useEffect(() => {
    if (!selectedMark || !mapRef.current) return
    mapRef.current.flyTo({ center: [...(selectedMark.actual ?? selectedMark.target)], zoom: 15.3 })
  }, [selectedMark])

  useEffect(() => () => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current)
  }, [])

  const openManualEditor = () => {
    if (!manualReference || !selectedMark) return
    const latitude = decimalMinuteTailParts(manualReference[1], 'latitude')
    const longitude = decimalMinuteTailParts(manualReference[0], 'longitude')
    setManualEntryMode('dmm-tail-4')
    setManualLatitude(latitude.tail)
    setManualLongitude(longitude.tail)
    setManualAccuracy('')
    setManualNote('ハンディGPSから転記')
    setManualDifferenceConfirmed(false)
    setManualEntryError(undefined)
    setExpandedMarkId(selectedMark.id)
    setManualEditorMarkId(selectedMark.id)
  }

  const changeManualEntryMode = (mode: CoordinateEntryMode) => {
    if (!manualReference) return
    if (mode === 'dmm-tail-4') {
      setManualLatitude(decimalMinuteTailParts(manualReference[1], 'latitude').tail)
      setManualLongitude(decimalMinuteTailParts(manualReference[0], 'longitude').tail)
    } else if (mode === 'decimal-tail-4') {
      setManualLatitude(decimalTailParts(manualReference[1]).tail)
      setManualLongitude(decimalTailParts(manualReference[0]).tail)
    } else {
      setManualLatitude(manualReference[1].toFixed(6))
      setManualLongitude(manualReference[0].toFixed(6))
    }
    setManualEntryMode(mode)
    setManualDifferenceConfirmed(false)
    setManualEntryError(undefined)
  }

  const submitManualPosition = (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedMark || !manualReference) return
    if (!manualDatumConfirmed) {
      setManualEntryError(DATUM_CONFIRMATION_ERROR)
      requestAnimationFrame(() => manualEditorRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
      return
    }
    try {
      const position = manualEntryMode === 'decimal-tail-4'
        ? positionFromDecimalTails(manualReference, manualLatitude, manualLongitude)
        : manualEntryMode === 'dmm-tail-4'
          ? positionFromDecimalMinuteTails(manualReference, manualLatitude, manualLongitude)
          : positionFromFullDecimal(manualLatitude, manualLongitude)
      const accuracyMetres = manualAccuracy.trim() === '' ? undefined : Number(manualAccuracy)
      if (accuracyMetres !== undefined && (!Number.isFinite(accuracyMetres) || accuracyMetres < 0 || accuracyMetres > 10_000)) {
        throw new Error('GPS精度は0〜10,000mで入力してください')
      }
      const difference = distanceMetres(selectedMark.target, position)
      if (difference > 1_000 && !manualDifferenceConfirmed) {
        throw new Error(`計画位置から${Math.round(difference)}m離れています。座標を確認してチェックを入れてください`)
      }
      onRecordManualPosition(selectedMark.id, position, {
        entryMode: manualEntryMode,
        accuracyMetres,
        note: manualNote.trim() || undefined,
      })
      setManualEditorMarkId(undefined)
      setExpandedMarkId(undefined)
      setManualEntryError(undefined)
    } catch (reason) {
      setManualEntryError(reason instanceof Error ? reason.message : '座標を確認してください')
      requestAnimationFrame(() => manualEditorRef.current?.scrollTo({
        top: manualEditorRef.current.scrollHeight,
        behavior: 'smooth',
      }))
    }
  }

  const fitCourse = () => {
    const map = mapRef.current
    if (!map || marks.length === 0) return
    const bounds = new maplibregl.LngLatBounds()
    marks.forEach((mark) => {
      bounds.extend([...mark.target])
      if (mark.actual) bounds.extend([...mark.actual])
    })
    boats.forEach((boat) => bounds.extend([...boat.position]))
    map.fitBounds(bounds, { padding: 54, maxZoom: 15 })
  }

  const locate = () => {
    if (!navigator.geolocation) {
      setLocationError('この端末では位置情報を利用できません')
      return
    }
    if (watchRef.current != null) {
      navigator.geolocation.clearWatch(watchRef.current)
      watchRef.current = undefined
      setTracking(false)
      return
    }
    firstTrackingFix.current = true
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const next: LngLat = [position.coords.longitude, position.coords.latitude]
        setLocationError(undefined)
        onUseCurrentLocation(next, {
          speedKnots: position.coords.speed == null ? undefined : position.coords.speed * 1.943844,
          courseDegrees: position.coords.heading == null || (position.coords.speed ?? 0) < 0.5 ? undefined : position.coords.heading,
          accuracyMetres: position.coords.accuracy,
        })
        if (firstTrackingFix.current) {
          firstTrackingFix.current = false
          mapRef.current?.flyTo({ center: [...next], zoom: 15.5 })
        }
      },
      () => setLocationError('位置情報を取得できません。端末の許可を確認してください'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 12_000 },
    )
    setTracking(true)
  }

  return (
    <section className="map-shell" aria-label="レース海面地図">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-topbar glass-panel">
        <div className="map-topbar__primary">
          <span className="eyebrow"><Radio size={13} /> {raceAreaName ?? 'レース海面'}・LIVE</span>
          <strong>{raceAreaName ?? 'レース海面'} コース設営</strong>
          <small className="map-primary-guidance">① 下の地点を選ぶ → ②「マーク／ライン操作」</small>
        </div>
        <div className="map-environment">
          <div className="map-weather">
            <Wind size={17} />
            <span>風 <strong>{formatTrueBearing(wind.directionDegrees)}</strong> / {wind.speedKnots.toFixed(1)} kt</span>
            <span className={`freshness ${windAgeSeconds > 30 ? 'is-stale' : ''}`}>{windAgeSeconds > 30 ? '古い・' : ''}{freshnessLabel(windAgeSeconds)}</span>
          </div>
          <div className="map-weather map-current">
            <span className="current-direction" style={{ transform: `rotate(${current.directionDegrees}deg)` }} aria-hidden="true">↑</span>
            <span>潮流 <strong>{formatTrueBearing(current.directionDegrees)}</strong> → / {current.speedKnots.toFixed(1)} kt</span>
            <span className={`freshness ${currentAgeSeconds > 30 ? 'is-stale' : ''}`}>{currentAgeSeconds > 30 ? '古い・' : ''}{freshnessLabel(currentAgeSeconds)}</span>
          </div>
        </div>
      </div>

      <div className="map-actions" aria-label="地図操作">
        <button type="button" className="map-action" onClick={fitCourse}>
          <Crosshair size={18} />
          <span>全体</span>
        </button>
        <button type="button" className={`map-action map-action--primary ${tracking ? 'is-tracking' : ''}`} onClick={locate}>
          <LocateFixed size={18} />
          <span>{tracking ? '共有停止' : '位置共有'}</span>
        </button>
      </div>

      <div className="map-legend glass-panel" aria-label="地図凡例">
        <span><i className="legend-target" /> 計画</span>
        <span><i className="legend-actual" /> 投下地点</span>
        <span><i className="legend-verification" /> 位置確認</span>
        <span><i className="legend-recovery" /> 回収地点</span>
        <span><i className="legend-gate-center" /> ゲート中央</span>
        <span><Navigation size={13} /> 運営ボート</span>
      </div>

      <div className="map-mark-strip" aria-label="マーク一覧">
        {marks.map((mark) => (
          <button
            type="button"
            className={`mark-chip ${selectedMarkId === mark.id ? 'is-selected' : ''}`}
            aria-pressed={selectedMarkId === mark.id}
            key={mark.id}
            onClick={() => {
              setManualEditorMarkId(undefined)
              setExpandedMarkId(undefined)
              setManualEntryError(undefined)
              onSelectMark(selectedMarkId === mark.id ? undefined : mark.id)
            }}
          >
            <span>{mark.shortLabel}</span>
            <small>{markStatusLabel(mark.status)}</small>
          </button>
        ))}
      </div>

      {selectedMark && (
        <article className={`selected-mark glass-panel ${markDetailsExpanded ? 'selected-mark--expanded' : ''} ${manualEditorMarkId === selectedMark.id ? 'selected-mark--editing' : ''}`}>
          <div className="selected-mark__icon"><MapPin size={19} /></div>
          <div className="selected-mark__body">
            <span className="eyebrow">{selectedMark.label}</span>
            {selfBoat ? <>
              <strong>{formatDistance(selectedDistance ?? 0)}</strong>
              <small className="selected-mark__navigation">
                目標方位 {formatTrueBearing(selectedBearing ?? 0)}・{formatEta(selectedEta)}
              </small>
              <small className="selected-mark__navigation">
                {selfBoat.courseDegrees === undefined ? 'COG —（低速または取得不可）' : `COG ${formatTrueBearing(selfBoat.courseDegrees)}・方位差 ${headingDifference === undefined || Math.abs(headingDifference) < 1 ? '0°' : `${headingDifference > 0 ? '右' : '左'}${Math.round(Math.abs(headingDifference))}°`}`}
                {selectedMark.actual && `・計画差 ${Math.round(distanceMetres(selectedMark.target, selectedMark.actual))}m`}
              </small>
            </> : <small className="selected-mark__navigation">運営ボート位置未取得・時刻記録は利用可能</small>}
            {verificationDifference !== undefined && <small className="mark-verification-status"><BadgeCheck size={12} /> 別位置観測との差 {verificationDifference.toFixed(1)}m</small>}
            {selectedMark.recoveryPosition && <small className="mark-recovery-status"><Anchor size={12} /> 回収地点 {selectedMark.recoveryPosition[1].toFixed(5)}, {selectedMark.recoveryPosition[0].toFixed(5)}</small>}
            {selectedGate && <small className="gate-metrics">{selectedGate.actual ? '実測' : '計画'}ゲート 幅 {Math.round(distanceMetres(selectedGate.positions[0], selectedGate.positions[1]))}m・方位 {formatTrueBearing(bearingDegrees(selectedGate.positions[0], selectedGate.positions[1]))}・中央 {selectedGate.center[1].toFixed(5)}, {selectedGate.center[0].toFixed(5)}</small>}
            {selectedAdoptedPassage && <small className="passage-recorded">採用 先頭通過 {new Date(selectedAdoptedPassage.passedAt).toLocaleTimeString('ja-JP')}</small>}
            {selectedPassageObservations.length > 0 && (
              <div className="passage-observations" aria-label="先頭通過の観測候補">
                <span className="passage-observations__summary">
                  観測 {selectedPassageObservations.length}件
                  {!selectedAdoptedPassage && '・未採用'}
                  {selectedPassage?.hasConflict && <em><AlertTriangle size={12} /> 差 {(selectedPassage.spreadMilliseconds / 1_000).toFixed(1)}秒</em>}
                </span>
                {selectedPassageObservations.map((observation) => (
                  <span className={`passage-candidate ${observation.id === selectedPassage?.adoptedObservationId ? 'is-adopted' : ''}`} key={observation.id}>
                    <span>
                      <strong>{new Date(observation.passedAt).toLocaleTimeString('ja-JP')}</strong>
                      <small>{observation.recordedBy}{observation.wasOffline ? '・オフライン観測' : ''}</small>
                    </span>
                    {canAdoptLeadingPassage && observation.id !== selectedPassage?.adoptedObservationId && (
                      <button type="button" onClick={() => onAdoptLeadingPassage(selectedMark.id, observation.id)} disabled={passageLocked}>採用</button>
                    )}
                    {observation.id === selectedPassage?.adoptedObservationId && <b>採用済</b>}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="selected-mark__toggle"
            aria-expanded={markDetailsExpanded}
            onClick={() => {
              setExpandedMarkId(markDetailsExpanded ? undefined : selectedMark.id)
              if (markDetailsExpanded) setManualEditorMarkId(undefined)
            }}
          >
            <span>{markDetailsExpanded ? '地図へ戻る' : selectedIsStartEndpoint ? 'ライン操作' : 'マーク操作'}</span>
            <ChevronDown size={17} />
          </button>
          <div className="selected-mark__actions">
            <button type="button" onClick={() => onRecordDrop(selectedMark.id)} disabled={locked || !selfBoat || !canManageSelectedMark}>
              <CircleCheckBig size={14} /> {selectedIsStartEndpoint
                ? selectedMark.actual ? '現在地へライン位置を更新' : '現在地をライン位置に記録'
                : selectedMark.actual ? '現在地へ再投下' : '現在地を投下地点に記録'}
            </button>
            <button type="button" onClick={openManualEditor} disabled={!canManageSelectedMark || locked && !canEditFinalizedPosition}>
              <PencilLine size={14} /> GPS数値を手入力
            </button>
            {selectedMark.status === 'deployed' && (
              <button type="button" className="mark-action--verify" onClick={() => onRecordConfirmation(selectedMark.id)} disabled={locked || !selfBoat || !canVerifyMarks}>
                <BadgeCheck size={14} /> 現在地から位置確認
              </button>
            )}
            {selectedMark.label !== 'シグナルボート' && (selectedMark.status === 'deployed' || selectedMark.status === 'confirmed') && (
              <button
                type="button"
                className="mark-action--recover"
                onClick={() => {
                  if (window.confirm(`${selectedMark.label}を回収済みとして記録しますか？`)) onRecordRecovery(selectedMark.id)
                }}
                disabled={locked || !selfBoat || !canManageSelectedMark}
              >
                <Anchor size={14} /> 回収済みにする
              </button>
            )}
            {!selectedIsStartEndpoint && <button type="button" onClick={() => onRecordLeadingPassage(selectedMark.id)} disabled={passageLocked}>
              <Timer size={14} /> {selectedPassageObservations.length ? '別観測を追加' : '先頭通過を記録'}
            </button>}
          </div>
          {manualEditorMarkId === selectedMark.id && manualReference && (
            <form ref={manualEditorRef} className="manual-position-editor" onSubmit={submitManualPosition}>
              <header>
                <span>
                  <strong>{selectedMark.label}：ハンディGPSの{selectedIsStartEndpoint ? 'ライン位置' : '投下位置'}</strong>
                  <small>{manualEntryMode === 'dmm-tail-4' ? '度＋10進分（DD°MM.mmmm′）' : '10進度（DD.dddddd°）'}・WGS 84</small>
                </span>
                <span className="manual-position-header-actions">
                  <button type="button" onClick={() => setManualEditorMarkId(undefined)}>閉じる</button>
                  <button type="submit" className="manual-position-quick-save">保存</button>
                </span>
              </header>
              <div className="manual-position-modes" aria-label="座標入力方式">
                <button type="button" className={manualEntryMode === 'dmm-tail-4' ? 'is-active' : ''} onClick={() => changeManualEntryMode('dmm-tail-4')}>GPS度分・末尾4桁</button>
                <button type="button" className={manualEntryMode === 'decimal-tail-4' ? 'is-active' : ''} onClick={() => changeManualEntryMode('decimal-tail-4')}>10進度・末尾4桁</button>
                <button type="button" className={manualEntryMode === 'decimal-full' ? 'is-active' : ''} onClick={() => changeManualEntryMode('decimal-full')}>10進度・全桁</button>
              </div>
              <small className="manual-position-guidance">
                末尾4桁では計画位置または直前の投下位置から上位桁を補います。GPS表示の上位桁が異なる場合は「10進度・全桁」を選んでください。
              </small>
              <label className={`manual-position-datum ${manualDatumError ? 'is-error' : ''}`}>
                <input
                  type="checkbox"
                  checked={manualDatumConfirmed}
                  onChange={(event) => {
                    setManualDatumConfirmed(event.target.checked)
                    if (event.target.checked && manualDatumError) setManualEntryError(undefined)
                  }}
                />
                <span>GPS側の測地系をWGS 84に設定済み</span>
                {manualDatumError && <small role="alert">ここを確認してから保存</small>}
              </label>
              <div className="manual-position-fields">
                <label>
                  <span>緯度</span>
                  <span className="coordinate-input">{manualEntryMode === 'dmm-tail-4' && <b>{decimalMinuteTailParts(manualReference[1], 'latitude').prefix}</b>}{manualEntryMode === 'decimal-tail-4' && <b>{decimalTailParts(manualReference[1]).prefix}</b>}<input aria-label="ハンディGPS緯度" inputMode={manualEntryMode === 'decimal-full' ? 'decimal' : 'numeric'} autoComplete="off" value={manualLatitude} maxLength={14} onChange={(event) => setManualLatitude(manualEntryMode === 'decimal-full' ? event.target.value : event.target.value.replace(/\D/gu, '').slice(0, 4))} /></span>
                </label>
                <label>
                  <span>経度</span>
                  <span className="coordinate-input">{manualEntryMode === 'dmm-tail-4' && <b>{decimalMinuteTailParts(manualReference[0], 'longitude').prefix}</b>}{manualEntryMode === 'decimal-tail-4' && <b>{decimalTailParts(manualReference[0]).prefix}</b>}<input aria-label="ハンディGPS経度" inputMode={manualEntryMode === 'decimal-full' ? 'decimal' : 'numeric'} autoComplete="off" value={manualLongitude} maxLength={14} onChange={(event) => setManualLongitude(manualEntryMode === 'decimal-full' ? event.target.value : event.target.value.replace(/\D/gu, '').slice(0, 4))} /></span>
                </label>
                <label><span>GPS表示精度（m・任意）</span><input aria-label="ハンディGPS表示精度" type="number" min="0" max="10000" step="0.1" value={manualAccuracy} onChange={(event) => setManualAccuracy(event.target.value)} /></label>
              </div>
              <label className="manual-position-note"><span>メモ</span><input aria-label="ハンディGPS位置メモ" value={manualNote} maxLength={120} onChange={(event) => setManualNote(event.target.value)} /></label>
              {manualPreview && <small className="manual-position-preview">入力結果 {manualPreview[1].toFixed(6)}, {manualPreview[0].toFixed(6)}・計画差 {Math.round(manualTargetDifference ?? 0)}m</small>}
              {(manualTargetDifference ?? 0) > 1_000 && <label className="manual-position-confirm"><input type="checkbox" checked={manualDifferenceConfirmed} onChange={(event) => setManualDifferenceConfirmed(event.target.checked)} /> 計画位置から1km以上離れていることを確認</label>}
              {manualEntryError && !manualDatumError && <small className="manual-position-error" role="alert">{manualEntryError}</small>}
              <button type="submit" className="manual-position-submit">この座標を投下地点として記録</button>
            </form>
          )}
        </article>
      )}

      {locationError && <div className="map-error" role="alert">{locationError}</div>}
      {basemapUnavailable && <div className="map-basemap-status" role="status"><CloudOff size={14} /><span><strong>背景地図オフライン</strong><small>コース・マーク・運営ボート表示は継続中</small></span></div>}
      <div className="map-offline-grid" aria-hidden="true" />
      <div className="map-watermark"><Waves size={14} /> 海上運営支援・航海用ではありません</div>
    </section>
  )
}
