import {
  AlertTriangle,
  CircleCheckBig,
  Crosshair,
  LocateFixed,
  MapPin,
  Navigation,
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

interface MapViewProps {
  marks: readonly CourseMark[]
  boats: readonly CommitteeBoat[]
  wind: WindObservation
  current: CurrentObservation
  selectedMarkId?: string
  onSelectMark: (markId?: string) => void
  onUseCurrentLocation: (position: LngLat, motion: { speedKnots?: number; courseDegrees?: number; accuracyMetres?: number }) => void
  onRecordDrop: (markId: string) => void
  onRecordLeadingPassage: (markId: string) => void
  onAdoptLeadingPassage: (markId: string, observationId: string) => void
  leadingPassages: Readonly<Record<string, LeadingPassageVisit>>
  raceId: string
  locked: boolean
  passageLocked: boolean
  canAdoptLeadingPassage: boolean
}

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    gsi: {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution:
        '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
      maxzoom: 18,
    },
  },
  layers: [
    { id: 'water-background', type: 'background', paint: { 'background-color': '#bfe7fb' } },
    { id: 'gsi-map', type: 'raster', source: 'gsi', paint: { 'raster-opacity': 0.76 } },
  ],
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
  onRecordLeadingPassage,
  onAdoptLeadingPassage,
  leadingPassages,
  raceId,
  locked,
  passageLocked,
  canAdoptLeadingPassage,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRefs = useRef<maplibregl.Marker[]>([])
  const watchRef = useRef<number | undefined>(undefined)
  const firstTrackingFix = useRef(true)
  const [mapReady, setMapReady] = useState(false)
  const [locationError, setLocationError] = useState<string>()
  const [tracking, setTracking] = useState(false)
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())
  const features = useMemo(() => buildCourseFeatures(marks), [marks])
  const initialFeaturesRef = useRef(features)
  const selectedMark = marks.find((mark) => mark.id === selectedMarkId)
  const selfBoat = boats.find((boat) => boat.isSelf)
  const selectedPassage = selectedMark ? leadingPassages[passageVisitKey(raceId, selectedMark.id, 1)] : undefined
  const selectedPassageObservations = selectedPassage?.observations.filter((observation) => observation.status === 'active') ?? []
  const selectedAdoptedPassage = selectedPassageObservations.find((observation) => observation.id === selectedPassage?.adoptedObservationId)
  const selectedDestination = selectedMark?.actual ?? selectedMark?.target
  const selectedDistance = selfBoat && selectedDestination ? distanceMetres(selfBoat.position, selectedDestination) : undefined
  const selectedBearing = selfBoat && selectedDestination ? bearingDegrees(selfBoat.position, selectedDestination) : undefined
  const headingDifference = selfBoat?.courseDegrees !== undefined && selectedBearing !== undefined
    ? headingDifferenceDegrees(selfBoat.courseDegrees, selectedBearing)
    : undefined
  const selectedEta = selfBoat && selectedDistance !== undefined ? estimateEtaSeconds(selectedDistance, selfBoat.speedKnots) : undefined
  const selectedGate = selectedMark ? findGatePairs(marks).find((gate) => gate.starboard.id === selectedMark.id || gate.port.id === selectedMark.id) : undefined
  const windAgeSeconds = observationAgeSeconds(wind.observedAt, freshnessNow)
  const currentAgeSeconds = observationAgeSeconds(current.observedAt, freshnessNow)

  useEffect(() => {
    const interval = window.setInterval(() => setFreshnessNow(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
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
          <span className="eyebrow"><Radio size={13} /> 海面A・LIVE</span>
          <strong>江の島沖 コース設営</strong>
        </div>
        <div className="map-environment">
          <div className="map-weather">
            <Wind size={17} />
            <span>風 <strong>{wind.directionDegrees}°T</strong> / {wind.speedKnots.toFixed(1)} kt</span>
            <span className={`freshness ${windAgeSeconds > 30 ? 'is-stale' : ''}`}>{windAgeSeconds > 30 ? '古い・' : ''}{freshnessLabel(windAgeSeconds)}</span>
          </div>
          <div className="map-weather map-current">
            <span className="current-direction" style={{ transform: `rotate(${current.directionDegrees}deg)` }} aria-hidden="true">↑</span>
            <span>潮流 <strong>{current.directionDegrees}°T</strong> → / {current.speedKnots.toFixed(1)} kt</span>
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
        <span><i className="legend-gate-center" /> ゲート中央</span>
        <span><Navigation size={13} /> 運営ボート</span>
      </div>

      <div className="map-mark-strip" aria-label="マーク一覧">
        {marks.filter((mark) => !mark.id.startsWith('start-')).map((mark) => (
          <button
            type="button"
            className={`mark-chip ${selectedMarkId === mark.id ? 'is-selected' : ''}`}
            key={mark.id}
            onClick={() => onSelectMark(selectedMarkId === mark.id ? undefined : mark.id)}
          >
            <span>{mark.shortLabel}</span>
            <small>{mark.status === 'confirmed' ? '確認済' : mark.status === 'deployed' ? '投下済' : '移動中'}</small>
          </button>
        ))}
      </div>

      {selectedMark && (
        <article className="selected-mark glass-panel">
          <div className="selected-mark__icon"><MapPin size={19} /></div>
          <div className="selected-mark__body">
            <span className="eyebrow">{selectedMark.label}</span>
            {selfBoat ? <>
              <strong>{formatDistance(selectedDistance ?? 0)}</strong>
              <small className="selected-mark__navigation">
                目標方位 {Math.round(selectedBearing ?? 0)}°T・{formatEta(selectedEta)}
              </small>
              <small className="selected-mark__navigation">
                {selfBoat.courseDegrees === undefined ? 'COG —（低速または取得不可）' : `COG ${Math.round(selfBoat.courseDegrees)}°T・方位差 ${headingDifference === undefined || Math.abs(headingDifference) < 1 ? '0°' : `${headingDifference > 0 ? '右' : '左'}${Math.round(Math.abs(headingDifference))}°`}`}
                {selectedMark.actual && `・計画差 ${Math.round(distanceMetres(selectedMark.target, selectedMark.actual))}m`}
              </small>
            </> : <small className="selected-mark__navigation">運営ボート位置未取得・時刻記録は利用可能</small>}
            {selectedGate && <small className="gate-metrics">{selectedGate.actual ? '実測' : '計画'}ゲート 幅 {Math.round(distanceMetres(selectedGate.positions[0], selectedGate.positions[1]))}m・方位 {Math.round(bearingDegrees(selectedGate.positions[0], selectedGate.positions[1]))}°T・中央 {selectedGate.center[1].toFixed(5)}, {selectedGate.center[0].toFixed(5)}</small>}
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
          <div className="selected-mark__actions">
            <button type="button" onClick={() => onRecordDrop(selectedMark.id)} disabled={locked || !selfBoat}>
              <CircleCheckBig size={14} /> 現在地を投下地点に記録
            </button>
            <button type="button" onClick={() => onRecordLeadingPassage(selectedMark.id)} disabled={passageLocked}>
              <Timer size={14} /> {selectedPassageObservations.length ? '別観測を追加' : '先頭通過を記録'}
            </button>
          </div>
        </article>
      )}

      {locationError && <div className="map-error" role="alert">{locationError}</div>}
      <div className="map-offline-grid" aria-hidden="true" />
      <div className="map-watermark"><Waves size={14} /> 海上運営支援・航海用ではありません</div>
    </section>
  )
}
