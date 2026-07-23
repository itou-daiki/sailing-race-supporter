import L, { type LayerGroup, type Map as LeafletMap, type Marker } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle, Check, Crosshair, LocateFixed, MapPin, Move, Navigation, ShieldCheck, Trash2, Wind, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CourseMark, LngLat } from '../domain'
import { bearingDegrees } from '../course'
import { buildCourseFeatures } from '../mapCourseFeatures'
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

function toLatLng(position: readonly number[]): L.LatLngTuple {
  return [position[1], position[0]]
}

interface LabelBox {
  left: number
  top: number
  right: number
  bottom: number
}

function boxesOverlap(first: LabelBox, second: LabelBox): boolean {
  return first.left < second.right
    && first.right > second.left
    && first.top < second.bottom
    && first.bottom > second.top
}

function chooseLabelOffset(
  map: LeafletMap,
  position: L.LatLngExpression,
  size: L.PointTuple,
  occupied: LabelBox[],
): L.PointTuple {
  const point = map.latLngToContainerPoint(position)
  const container = map.getContainer()
  const candidates: L.PointTuple[] = [
    [0, -16],
    [0, 16],
    [-42, 0],
    [42, 0],
    [-42, -22],
    [42, -22],
    [-42, 22],
    [42, 22],
    [0, -38],
    [0, 38],
  ]
  const boxFor = ([offsetX, offsetY]: L.PointTuple): LabelBox => ({
    left: point.x + offsetX - size[0] / 2,
    top: point.y + offsetY - size[1] / 2,
    right: point.x + offsetX + size[0] / 2,
    bottom: point.y + offsetY + size[1] / 2,
  })
  const inViewport = (box: LabelBox) => (
    box.left >= 4
    && box.top >= 4
    && box.right <= container.clientWidth - 4
    && box.bottom <= container.clientHeight - 4
  )
  const chosen = candidates.find((candidate) => {
    const box = boxFor(candidate)
    return inViewport(box) && occupied.every((other) => !boxesOverlap(box, other))
  }) ?? candidates.reduce((best, candidate) => {
    const score = occupied.filter((other) => boxesOverlap(boxFor(candidate), other)).length
      + (inViewport(boxFor(candidate)) ? 0 : 100)
    return score < best.score ? { candidate, score } : best
  }, { candidate: candidates[0], score: Number.POSITIVE_INFINITY }).candidate
  occupied.push(boxFor(chosen))
  return chosen
}

function textIcon(className: string, text: string, size: L.PointTuple = [120, 28], offset: L.PointTuple = [0, 0]): L.DivIcon {
  const element = document.createElement('span')
  element.textContent = text
  return L.divIcon({
    className,
    html: element,
    iconSize: size,
    iconAnchor: [size[0] / 2 - offset[0], size[1] / 2 - offset[1]],
  })
}

function offsetLine(map: LeafletMap, coordinates: readonly number[][], offset: number): L.LatLng[] {
  const positions = coordinates.map((coordinate) => L.latLng(toLatLng(coordinate)))
  if (!offset || positions.length < 2) return positions
  const start = map.latLngToLayerPoint(positions[0])
  const end = map.latLngToLayerPoint(positions[positions.length - 1])
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  if (length < 1) return positions
  const offsetX = (-(end.y - start.y) / length) * offset
  const offsetY = ((end.x - start.x) / length) * offset
  return positions.map((position) => {
    const point = map.latLngToLayerPoint(position)
    return map.layerPointToLatLng(L.point(point.x + offsetX, point.y + offsetY))
  })
}

function markerDescription(mark: CourseMark, finishLineMode: CoursePreviewMapProps['finishLineMode']): string {
  if (mark.shortLabel === 'RC') return finishLineMode === 'shared-rc' ? '本部船・スタート／フィニッシュ兼用' : '本部船・スタート右端'
  if (mark.shortLabel === 'FIN') return 'フィニッシュ艇'
  if (mark.shortLabel === 'F') return 'フィニッシュマーク'
  if (mark.shortLabel === 'PIN') return 'ピン・左端'
  return mark.label
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
  const mapRef = useRef<LeafletMap | null>(null)
  const courseLayerRef = useRef<LayerGroup | null>(null)
  const markerLayerRef = useRef<LayerGroup | null>(null)
  const currentPositionMarkerRef = useRef<Marker | null>(null)
  const hasFittedCurrentPositionRef = useRef(false)
  const fittedMarkPositionsRef = useRef('')
  const initialCenterRef = useRef(signalBoatPosition)
  const onPositionChangeRef = useRef(onSignalBoatPositionChange)
  const onMarkSelectRef = useRef(onMarkSelect)
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState(false)
  const [editingSignalBoat, setEditingSignalBoat] = useState(false)
  const features = useMemo(() => buildCourseFeatures(marks, route), [marks, route])
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
    if (!containerRef.current || mapRef.current) return
    let active = true
    let frame = 0
    try {
      const center = toLatLng(initialCenterRef.current)
      const map = L.map(containerRef.current, {
        attributionControl: false,
        center,
        doubleClickZoom: true,
        minZoom: 6,
        maxZoom: 18,
        preferCanvas: false,
        scrollWheelZoom: true,
        touchZoom: true,
        zoom: 13.25,
        zoomControl: false,
        zoomSnap: 0.25,
      })
      mapRef.current = map
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>',
        maxZoom: 18,
        minZoom: 6,
        opacity: 0.82,
      }).addTo(map)
      L.control.zoom({ position: containerRef.current.clientWidth <= 520 ? 'topright' : 'bottomright' }).addTo(map)
      L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map)
      courseLayerRef.current = L.layerGroup().addTo(map)
      markerLayerRef.current = L.layerGroup().addTo(map)
      frame = window.requestAnimationFrame(() => {
        if (!active) return
        map.invalidateSize(false)
        setMapReady(true)
      })
    } catch {
      window.queueMicrotask(() => {
        if (active) setMapError(true)
      })
    }
    return () => {
      active = false
      window.cancelAnimationFrame(frame)
      currentPositionMarkerRef.current?.remove()
      currentPositionMarkerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
      courseLayerRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = courseLayerRef.current
    if (!map || !layer || !mapReady) return

    const drawCourse = () => {
      layer.clearLayers()
      const compactLabels = map.getContainer().clientWidth <= 520 && map.getZoom() < 14.5
      const occupiedLabels: LabelBox[] = marks.map((mark) => {
        const point = map.latLngToContainerPoint(toLatLng(mark.actual ?? mark.target))
        const width = mark.shortLabel === 'RC' ? 62 : mark.shortLabel === 'FIN' ? 50 : 40
        const height = mark.shortLabel === 'RC' ? 50 : 40
        return {
          left: point.x - width / 2 - 4,
          top: point.y - height / 2 - 4,
          right: point.x + width / 2 + 4,
          bottom: point.y + height / 2 + 4,
        }
      })
      features.startLine.features.forEach((feature) => {
        const positions = feature.geometry.coordinates.map(toLatLng)
        L.polyline(positions, { color: '#ffffff', weight: 9, opacity: 0.96, interactive: false }).addTo(layer)
        L.polyline(positions, { color: '#ff6b00', weight: 5, opacity: 1, interactive: false }).addTo(layer)
      })
      features.finishLine.features.forEach((feature) => {
        const positions = feature.geometry.coordinates.map(toLatLng)
        L.polyline(positions, { color: '#ffffff', weight: 9, opacity: 0.96, interactive: false }).addTo(layer)
        L.polyline(positions, { color: '#13a66b', weight: 5, opacity: 1, interactive: false }).addTo(layer)
      })
      features.courseSegments.features.forEach((feature) => {
        const offset = Number(feature.properties?.offset ?? 0)
        const positions = offsetLine(map, feature.geometry.coordinates, offset)
        L.polyline(positions, { color: '#087ee8', dashArray: '10 6', weight: 4, opacity: 0.82, interactive: false }).addTo(layer)
        if (positions.length < 2) return
        const from = positions[0]
        const to = positions[positions.length - 1]
        const heading = bearingDegrees([from.lng, from.lat], [to.lng, to.lat])
        const arrow = document.createElement('span')
        arrow.textContent = '▲'
        arrow.style.transform = `rotate(${heading}deg)`
        L.marker(L.latLng((from.lat + to.lat) / 2, (from.lng + to.lng) / 2), {
          icon: L.divIcon({ className: 'pre-event-course-arrow', html: arrow, iconSize: [20, 20], iconAnchor: [10, 10] }),
          interactive: false,
          keyboard: false,
        }).addTo(layer)
      })
      features.gates.features.forEach((feature) => {
        L.polyline(feature.geometry.coordinates.map(toLatLng), { color: '#7b4bb7', dashArray: '6 5', weight: 4, interactive: false }).addTo(layer)
      })
      features.legLabels.features.forEach((feature) => {
        const position = toLatLng(feature.geometry.coordinates)
        const size: L.PointTuple = compactLabels ? [78, 24] : [120, 28]
        const label = compactLabels ? feature.properties?.compactLabel : feature.properties?.label
        const offset = chooseLabelOffset(map, position, size, occupiedLabels)
        L.marker(position, {
          icon: textIcon(`pre-event-course-label is-distance${compactLabels ? ' is-compact' : ''}`, String(label ?? ''), size, offset),
          interactive: false,
          keyboard: false,
        }).addTo(layer)
      })
      if (map.getContainer().clientWidth <= 520 && map.getZoom() < 13.75) return
      features.turnLabels.features.forEach((feature) => {
        const position = toLatLng(feature.geometry.coordinates)
        const size: L.PointTuple = [58, 22]
        const offset = chooseLabelOffset(map, position, size, occupiedLabels)
        L.marker(position, {
          icon: textIcon('pre-event-course-label is-angle', String(feature.properties?.label ?? ''), size, offset),
          interactive: false,
          keyboard: false,
        }).addTo(layer)
      })
    }

    drawCourse()
    map.on('zoomend', drawCourse)
    return () => {
      map.off('zoomend', drawCourse)
      layer.clearLayers()
    }
  }, [features, mapReady, marks])

  useEffect(() => {
    const map = mapRef.current
    const layer = markerLayerRef.current
    if (!map || !layer || !mapReady) return
    layer.clearLayers()
    marks.forEach((mark) => {
      const element = document.createElement('div')
      element.className = `pre-event-map-mark ${mark.shortLabel === 'RC' ? 'is-signal-boat' : ''} ${mark.shortLabel === 'PIN' ? 'is-start-pin' : ''} ${mark.shortLabel === 'FIN' ? 'is-finish-boat' : ''} ${mark.shortLabel === 'F' ? 'is-finish-mark' : ''} ${mark.isGate ? 'is-gate' : ''} ${mark.shortLabel === 'RC' && editingSignalBoat ? 'is-editable' : ''} ${mark.actual ? 'is-recorded' : ''} ${mark.id === selectedMarkId ? 'is-selected' : ''} ${mark.id === navigationMarkId ? 'is-navigation-target' : ''}`
      element.setAttribute('aria-label', mark.shortLabel === 'RC'
        ? editingSignalBoat ? '本部船・押したままドラッグして移動' : '本部船・右端（移動ロック中）'
        : mark.label)
      const strong = document.createElement('strong')
      strong.textContent = mark.shortLabel
      const detail = document.createElement('span')
      detail.textContent = markerDescription(mark, finishLineMode)
      element.appendChild(strong)
      element.appendChild(detail)
      const signalBoat = mark.shortLabel === 'RC'
      const iconSize: L.PointTuple = signalBoat ? [64, 52] : [44, 44]
      const marker = L.marker(toLatLng(mark.actual ?? mark.target), {
        autoPan: true,
        draggable: signalBoat && editingSignalBoat,
        icon: L.divIcon({
          className: 'pre-event-leaflet-marker',
          html: element.outerHTML,
          iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
          iconSize,
        }),
        keyboard: true,
        alt: mark.label,
        title: markerDescription(mark, finishLineMode),
      }).addTo(layer)
      marker.on('click', (event) => {
        L.DomEvent.stopPropagation(event.originalEvent)
        onMarkSelectRef.current(mark)
      })
      if (signalBoat) marker.on('dragend', () => {
        const next = marker.getLatLng()
        onPositionChangeRef.current([next.lng, next.lat])
      })
    })

    const positionKey = marks.map((mark) => (mark.actual ?? mark.target).map((value) => value.toFixed(7)).join(',')).join('|')
    if (fittedMarkPositionsRef.current !== positionKey) {
      fittedMarkPositionsRef.current = positionKey
      const bounds = L.latLngBounds(marks.map((mark) => toLatLng(mark.actual ?? mark.target)))
      if (bounds.isValid()) map.fitBounds(bounds, {
        animate: true,
        duration: 0.25,
        maxZoom: 15,
        paddingBottomRight: map.getContainer().clientWidth <= 520 ? [48, 54] : [110, 100],
        paddingTopLeft: map.getContainer().clientWidth <= 520 ? [48, 62] : [110, 92],
      })
    }
    return () => {
      layer.clearLayers()
    }
  }, [editingSignalBoat, finishLineMode, mapReady, marks, navigationMarkId, selectedMarkId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!currentPosition) {
      currentPositionMarkerRef.current?.remove()
      currentPositionMarkerRef.current = null
      hasFittedCurrentPositionRef.current = false
      return
    }
    if (!currentPositionMarkerRef.current) {
      const element = document.createElement('div')
      element.className = 'pre-event-current-position'
      element.setAttribute('aria-label', '自分の現在地')
      element.innerHTML = '<span></span><strong>自分</strong>'
      currentPositionMarkerRef.current = L.marker(toLatLng(currentPosition), {
        icon: L.divIcon({ className: 'pre-event-leaflet-current', html: element, iconSize: [28, 28], iconAnchor: [14, 14] }),
        interactive: false,
        keyboard: false,
      }).addTo(map)
    }
    currentPositionMarkerRef.current.setLatLng(toLatLng(currentPosition))
    if (hasFittedCurrentPositionRef.current) return
    hasFittedCurrentPositionRef.current = true
    const bounds = L.latLngBounds(marks.map((mark) => toLatLng(mark.actual ?? mark.target)))
    bounds.extend(toLatLng(currentPosition))
    map.fitBounds(bounds, { animate: true, duration: 0.3, maxZoom: 15, padding: [56, 64] })
  }, [currentPosition, mapReady, marks])

  useEffect(() => {
    const map = mapRef.current
    const container = containerRef.current
    if (!map || !container || !mapReady || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => map.invalidateSize(false))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [mapReady])

  return (
    <section className="pre-event-map" aria-label="入力条件から作成した推奨マーク配置">
      <div ref={containerRef} className="pre-event-map__canvas" aria-label="推奨マーク配置の地図" />
      {mapError && (
        <div className="pre-event-map__compat-error" role="alert">
          <AlertTriangle size={20} />
          <span><strong>地図の初期化に失敗しました</strong><small>通常のSafariまたはChromeで開き直してください。</small></span>
          <button type="button" onClick={() => window.location.reload()}>再試行</button>
        </div>
      )}
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
