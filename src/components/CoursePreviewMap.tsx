import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from 'maplibre-gl'
import { Crosshair, Wind } from 'lucide-react'
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
  onSignalBoatPositionChange: (position: LngLat) => void
}

export function CoursePreviewMap({
  marks,
  route,
  signalBoatPosition,
  windDirection,
  windSpeed,
  onSignalBoatPositionChange,
}: CoursePreviewMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRefs = useRef<Marker[]>([])
  const initialCenterRef = useRef(signalBoatPosition)
  const onPositionChangeRef = useRef(onSignalBoatPositionChange)
  const [mapReady, setMapReady] = useState(false)
  const features = useMemo(() => buildCourseFeatures(marks, route), [marks, route])
  const initialFeaturesRef = useRef(features)

  useEffect(() => {
    onPositionChangeRef.current = onSignalBoatPositionChange
  }, [onSignalBoatPositionChange])

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
    map.on('click', (event) => onPositionChangeRef.current([event.lngLat.lng, event.lngLat.lat]))
    map.on('load', () => {
      map.addSource('preview-course', { type: 'geojson', data: initialFeaturesRef.current.course })
      map.addSource('preview-gates', { type: 'geojson', data: initialFeaturesRef.current.gates })
      map.addLayer({
        id: 'preview-course-line',
        type: 'line',
        source: 'preview-course',
        paint: { 'line-color': '#087ee8', 'line-width': 4, 'line-opacity': 0.78, 'line-dasharray': [2, 1.1] },
      })
      map.addLayer({
        id: 'preview-gate-line',
        type: 'line',
        source: 'preview-gates',
        paint: { 'line-color': '#7b4bb7', 'line-width': 4, 'line-dasharray': [1, 1] },
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
    ;(map.getSource('preview-course') as GeoJSONSource | undefined)?.setData(features.course)
    ;(map.getSource('preview-gates') as GeoJSONSource | undefined)?.setData(features.gates)
    markerRefs.current.forEach((marker) => marker.remove())
    markerRefs.current = marks.map((mark) => {
      const element = document.createElement('div')
      element.className = `pre-event-map-mark ${mark.shortLabel === 'RC' ? 'is-signal-boat' : ''} ${mark.isGate ? 'is-gate' : ''}`
      element.setAttribute('aria-label', mark.shortLabel === 'RC' ? '本部船・ドラッグして移動' : mark.label)
      element.innerHTML = `<strong>${mark.shortLabel}</strong><span>${mark.shortLabel === 'RC' ? '本部船' : mark.label}</span>`
      const marker = new maplibregl.Marker({
        element,
        anchor: 'center',
        draggable: mark.shortLabel === 'RC',
      }).setLngLat([...mark.target]).addTo(map)
      if (mark.shortLabel === 'RC') {
        marker.on('dragend', () => {
          const next = marker.getLngLat()
          onPositionChangeRef.current([next.lng, next.lat])
        })
      }
      return marker
    })
    const bounds = new maplibregl.LngLatBounds()
    marks.forEach((mark) => bounds.extend([...mark.target]))
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
  }, [features, mapReady, marks])

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
        marks.forEach((mark) => bounds.extend([...mark.target]))
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
      <p className="pre-event-map__hint">地図タップ／RCをドラッグで本部船を移動</p>
    </section>
  )
}
