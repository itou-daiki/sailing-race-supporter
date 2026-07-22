import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from 'maplibre-gl'
import { AlertTriangle, Check, Crosshair, LocateFixed, MapPin, Move, Navigation, ShieldCheck, Trash2, Wind, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CourseMark, LngLat } from '../domain'
import { buildCourseFeatures } from '../mapCourseFeatures'
import { GSI_MAP_STYLE } from '../mapStyle'
import { formatWindSpeedDual } from '../markWind'
import { formatTrueBearing } from '../../shared/trueBearing'

interface CoursePreviewMapProps {
  marks: readonly CourseMark[]
  route: readonly string[]
  signalBoatPosition: LngLat
  windDirection: number
  windSpeed: number
  finishLineMode: 'separate' | 'shared-rc'
  coastClearance: { status: 'checking' | 'safe' | 'unsafe' | 'unavailable'; label: string }
  currentPosition?: LngLat
  currentPositionAccuracy?: number
  selectedMarkId?: string
  navigationMarkId?: string
  navigationDistanceMetres?: number
  onMarkSelect: (mark: CourseMark) => void
  onCloseMark: () => void
  onNavigateToMark: (mark: CourseMark) => void
  onStopNavigation: () => void
  onRecordMark: () => void
  onClearRecordedMark: () => void
  onSignalBoatPositionChange: (position: LngLat) => void
}

export function CoursePreviewMap({
  marks,
  route,
  signalBoatPosition,
  windDirection,
  windSpeed,
  finishLineMode,
  coastClearance,
  currentPosition,
  currentPositionAccuracy,
  selectedMarkId,
  navigationMarkId,
  navigationDistanceMetres,
  onMarkSelect,
  onCloseMark,
  onNavigateToMark,
  onStopNavigation,
  onRecordMark,
  onClearRecordedMark,
  onSignalBoatPositionChange,
}: CoursePreviewMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRefs = useRef<Marker[]>([])
  const currentPositionMarkerRef = useRef<Marker | undefined>(undefined)
  const hasFittedCurrentPositionRef = useRef(false)
  const initialCenterRef = useRef(signalBoatPosition)
  const onPositionChangeRef = useRef(onSignalBoatPositionChange)
  const onMarkSelectRef = useRef(onMarkSelect)
  const [mapReady, setMapReady] = useState(false)
  const [editingSignalBoat, setEditingSignalBoat] = useState(false)
  const features = useMemo(() => buildCourseFeatures(marks, route), [marks, route])
  const initialFeaturesRef = useRef(features)
  const selectedMark = marks.find((mark) => mark.id === selectedMarkId)
  const navigationActive = Boolean(selectedMark && navigationMarkId === selectedMark.id)
  const selectedPosition = selectedMark ? selectedMark.actual ?? selectedMark.target : undefined

  useEffect(() => {
    onPositionChangeRef.current = onSignalBoatPositionChange
  }, [onSignalBoatPositionChange])

  useEffect(() => {
    onMarkSelectRef.current = onMarkSelect
  }, [onMarkSelect])

  useEffect(() => {
    if (!containerRef.current || mapRef.current || typeof WebGLRenderingContext === 'undefined') return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: GSI_MAP_STYLE,
      center: [...initialCenterRef.current],
      zoom: 13.3,
      minZoom: 6,
      maxZoom: 18,
      attributionControl: false,
      cooperativeGestures: false,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    map.on('load', () => {
      map.addSource('preview-course', { type: 'geojson', data: initialFeaturesRef.current.courseSegments })
      map.addSource('preview-gates', { type: 'geojson', data: initialFeaturesRef.current.gates })
      map.addSource('preview-start-line', { type: 'geojson', data: initialFeaturesRef.current.startLine })
      map.addSource('preview-finish-line', { type: 'geojson', data: initialFeaturesRef.current.finishLine })
      map.addSource('preview-leg-labels', { type: 'geojson', data: initialFeaturesRef.current.legLabels })
      map.addSource('preview-turn-labels', { type: 'geojson', data: initialFeaturesRef.current.turnLabels })
      map.addLayer({
        id: 'preview-start-line-casing',
        type: 'line',
        source: 'preview-start-line',
        paint: {
          'line-color': '#ffffff',
          'line-width': 8,
          'line-opacity': 0.96,
          'line-offset': ['case', ['boolean', ['get', 'shared'], false], 5, 0],
        },
      })
      map.addLayer({
        id: 'preview-start-line',
        type: 'line',
        source: 'preview-start-line',
        paint: { 'line-color': '#ff6b00', 'line-width': 5, 'line-opacity': 1 },
      })
      map.addLayer({
        id: 'preview-finish-line-casing',
        type: 'line',
        source: 'preview-finish-line',
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.96 },
      })
      map.addLayer({
        id: 'preview-finish-line',
        type: 'line',
        source: 'preview-finish-line',
        paint: {
          'line-color': '#13a66b',
          'line-width': 5,
          'line-opacity': 1,
        },
      })
      map.addLayer({
        id: 'preview-course-line',
        type: 'line',
        source: 'preview-course',
        paint: {
          'line-color': '#087ee8',
          'line-width': 4,
          'line-opacity': 0.78,
          'line-dasharray': [2, 1.1],
          'line-offset': ['get', 'offset'],
        },
      })
      map.addLayer({
        id: 'preview-course-direction',
        type: 'symbol',
        source: 'preview-course',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 95,
          'text-field': '▶',
          'text-size': 13,
          'text-rotation-alignment': 'map',
          'text-keep-upright': false,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-offset': ['get', 'textOffset'],
        },
        paint: { 'text-color': '#087ee8', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      })
      map.addLayer({
        id: 'preview-gate-line',
        type: 'line',
        source: 'preview-gates',
        paint: { 'line-color': '#7b4bb7', 'line-width': 4, 'line-dasharray': [1, 1] },
      })
      map.addLayer({
        id: 'preview-leg-distance-label',
        type: 'symbol',
        source: 'preview-leg-labels',
        layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#075f9f', 'text-halo-color': '#ffffff', 'text-halo-width': 3, 'text-halo-blur': 0.5 },
      })
      map.addLayer({
        id: 'preview-turn-angle-label',
        type: 'symbol',
        source: 'preview-turn-labels',
        layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.8], 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#5f36a0', 'text-halo-color': '#ffffff', 'text-halo-width': 3, 'text-halo-blur': 0.5 },
      })
      setMapReady(true)
    })
    return () => {
      markerRefs.current.forEach((marker) => marker.remove())
      markerRefs.current = []
      currentPositionMarkerRef.current?.remove()
      currentPositionMarkerRef.current = undefined
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    ;(map.getSource('preview-course') as GeoJSONSource | undefined)?.setData(features.courseSegments)
    ;(map.getSource('preview-gates') as GeoJSONSource | undefined)?.setData(features.gates)
    ;(map.getSource('preview-start-line') as GeoJSONSource | undefined)?.setData(features.startLine)
    ;(map.getSource('preview-finish-line') as GeoJSONSource | undefined)?.setData(features.finishLine)
    ;(map.getSource('preview-leg-labels') as GeoJSONSource | undefined)?.setData(features.legLabels)
    ;(map.getSource('preview-turn-labels') as GeoJSONSource | undefined)?.setData(features.turnLabels)
    markerRefs.current.forEach((marker) => marker.remove())
    markerRefs.current = marks.map((mark) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = `pre-event-map-mark ${mark.shortLabel === 'RC' ? 'is-signal-boat' : ''} ${mark.shortLabel === 'PIN' ? 'is-start-pin' : ''} ${mark.shortLabel === 'FIN' ? 'is-finish-boat' : ''} ${mark.shortLabel === 'F' ? 'is-finish-mark' : ''} ${mark.isGate ? 'is-gate' : ''} ${mark.shortLabel === 'RC' && editingSignalBoat ? 'is-editable' : ''} ${mark.actual ? 'is-recorded' : ''} ${mark.id === selectedMarkId ? 'is-selected' : ''} ${mark.id === navigationMarkId ? 'is-navigation-target' : ''}`
      element.setAttribute('aria-label', mark.shortLabel === 'RC'
        ? editingSignalBoat ? '本部船・押したままドラッグして移動' : '本部船・右端（移動ロック中）'
        : mark.label)
      const detail = mark.shortLabel === 'RC'
        ? finishLineMode === 'shared-rc' ? '本部船・スタート／フィニッシュ兼用' : '本部船・スタート右端'
        : mark.shortLabel === 'FIN' ? 'フィニッシュ艇'
          : mark.shortLabel === 'F' ? 'フィニッシュマーク'
        : mark.shortLabel === 'PIN' ? 'ピン・左端' : mark.label
      element.innerHTML = `<strong>${mark.shortLabel}</strong><span>${detail}</span>`
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        onMarkSelectRef.current(mark)
      })
      const marker = new maplibregl.Marker({
        element,
        anchor: 'center',
        draggable: mark.shortLabel === 'RC' && editingSignalBoat,
      }).setLngLat([...(mark.actual ?? mark.target)]).addTo(map)
      if (mark.shortLabel === 'RC') {
        marker.on('dragend', () => {
          const next = marker.getLngLat()
          onPositionChangeRef.current([next.lng, next.lat])
        })
      }
      return marker
    })
    const bounds = new maplibregl.LngLatBounds()
    marks.forEach((mark) => bounds.extend([...(mark.actual ?? mark.target)]))
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: map.getContainer().clientWidth <= 520
          ? { top: 62, right: 48, bottom: 54, left: 48 }
          : { top: 92, right: 110, bottom: 100, left: 110 },
        maxZoom: 15,
        duration: 250,
      })
    }
    return () => {
      markerRefs.current.forEach((marker) => marker.remove())
      markerRefs.current = []
    }
  }, [editingSignalBoat, features, finishLineMode, mapReady, marks, navigationMarkId, selectedMarkId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!currentPosition) {
      currentPositionMarkerRef.current?.remove()
      currentPositionMarkerRef.current = undefined
      hasFittedCurrentPositionRef.current = false
      return
    }
    if (!currentPositionMarkerRef.current) {
      const element = document.createElement('div')
      element.className = 'pre-event-current-position'
      element.setAttribute('aria-label', '自分の現在地')
      element.innerHTML = '<span></span><strong>自分</strong>'
      currentPositionMarkerRef.current = new maplibregl.Marker({ element, anchor: 'center' }).addTo(map)
    }
    currentPositionMarkerRef.current.setLngLat([...currentPosition])
    if (hasFittedCurrentPositionRef.current) return
    hasFittedCurrentPositionRef.current = true
    const bounds = new maplibregl.LngLatBounds()
    marks.forEach((mark) => bounds.extend([...(mark.actual ?? mark.target)]))
    bounds.extend([...currentPosition])
    map.fitBounds(bounds, {
      padding: map.getContainer().clientWidth <= 520
        ? { top: 62, right: 48, bottom: 54, left: 48 }
        : { top: 92, right: 110, bottom: 100, left: 110 },
      maxZoom: 15,
      duration: 300,
    })
  }, [currentPosition, mapReady, marks])

  useEffect(() => {
    const map = mapRef.current
    const container = containerRef.current
    if (!map || !container || !mapReady || typeof ResizeObserver === 'undefined') return

    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        map.resize()
        const bounds = new maplibregl.LngLatBounds()
        marks.forEach((mark) => bounds.extend([...(mark.actual ?? mark.target)]))
        if (bounds.isEmpty()) return
        map.fitBounds(bounds, {
          padding: container.clientWidth <= 520
            ? { top: 62, right: 48, bottom: 54, left: 48 }
            : { top: 92, right: 110, bottom: 100, left: 110 },
          maxZoom: 15,
          duration: 0,
        })
      })
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [mapReady, marks])

  return (
    <section className="pre-event-map" aria-label="入力条件から作成した推奨マーク配置">
      <div ref={containerRef} className="pre-event-map__canvas" aria-label="推奨マーク配置の地図" />
      <div className="pre-event-map__status">
        <span><Crosshair size={16} /><strong>推奨マーク配置</strong></span>
        <span><Wind size={16} />{formatTrueBearing(windDirection)}・{formatWindSpeedDual(windSpeed)}</span>
      </div>
      <div className={`pre-event-map__clearance is-${coastClearance.status}`}>
        {coastClearance.status === 'safe' ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
        <strong>{coastClearance.label}</strong>
      </div>
      {selectedMark && selectedPosition ? (
        <section className="pre-event-map__mark-card" aria-label={`${selectedMark.shortLabel}の座標と案内`}>
          <header>
            <span><MapPin size={16} /><strong>{selectedMark.shortLabel}</strong><small>{selectedMark.actual ? '記録座標' : '予定座標'}</small></span>
            <button type="button" aria-label="マーク詳細を閉じる" onClick={onCloseMark}><X size={16} /></button>
          </header>
          <p><span>緯度 {selectedPosition[1].toFixed(7)}</span><span>経度 {selectedPosition[0].toFixed(7)}</span></p>
          {navigationActive && <div className="pre-event-map__remaining"><Navigation size={16} /><span><small>このマークまで</small><strong>{navigationDistanceMetres === undefined ? '現在地を取得中' : `あと ${Math.round(navigationDistanceMetres).toLocaleString('ja-JP')} m`}</strong></span>{currentPositionAccuracy !== undefined && <small>精度 ±{Math.round(currentPositionAccuracy)}m</small>}</div>}
          <div className="pre-event-map__mark-actions">
            <button type="button" className={navigationActive ? 'is-active' : ''} onClick={() => navigationActive ? onStopNavigation() : onNavigateToMark(selectedMark)}><Navigation size={15} />{navigationActive ? '案内を終了' : 'ここに行く'}</button>
            <button type="button" disabled={!currentPosition} onClick={onRecordMark}><LocateFixed size={15} />現在地で打つ</button>
            {selectedMark.actual && <button type="button" className="is-danger" aria-label="端末内の記録座標を削除" onClick={onClearRecordedMark}><Trash2 size={15} /></button>}
          </div>
        </section>
      ) : (
        <>
          <button
            type="button"
            className={`pre-event-map__edit-toggle ${editingSignalBoat ? 'is-active' : ''}`}
            aria-pressed={editingSignalBoat}
            onClick={() => setEditingSignalBoat((current) => !current)}
          >
            {editingSignalBoat ? <Check size={15} /> : <Move size={15} />}
            {editingSignalBoat ? '移動を完了' : '本部船の位置を変える'}
          </button>
          <p className="pre-event-map__hint">{editingSignalBoat ? 'RCを押したままドラッグ' : 'マークをタップ：座標・ここに行く・現在地で打つ'}</p>
        </>
      )}
    </section>
  )
}
