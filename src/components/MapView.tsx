import {
  Crosshair,
  LocateFixed,
  MapPin,
  Navigation,
  Radio,
  Waves,
  Wind,
} from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FeatureCollection, LineString, Point } from 'geojson'
import { bearingDegrees, distanceMetres, formatDistance } from '../course'
import type { CommitteeBoat, CourseMark, LngLat, WindObservation } from '../domain'

interface MapViewProps {
  marks: readonly CourseMark[]
  boats: readonly CommitteeBoat[]
  wind: WindObservation
  selectedMarkId?: string
  onSelectMark: (markId?: string) => void
  onUseCurrentLocation: (position: LngLat) => void
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

function buildCourseFeatures(marks: readonly CourseMark[]): {
  points: FeatureCollection<Point>
  targetLinks: FeatureCollection<LineString>
  course: FeatureCollection<LineString>
} {
  const points: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: marks.flatMap((mark) => {
      const target = {
        type: 'Feature' as const,
        id: `${mark.id}-target`,
        properties: { markId: mark.id, kind: 'target', label: mark.shortLabel },
        geometry: { type: 'Point' as const, coordinates: [...mark.target] },
      }
      if (!mark.actual) return [target]
      return [
        target,
        {
          type: 'Feature' as const,
          id: `${mark.id}-actual`,
          properties: { markId: mark.id, kind: 'actual', label: mark.shortLabel },
          geometry: { type: 'Point' as const, coordinates: [...mark.actual] },
        },
      ]
    }),
  }

  const targetLinks: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: marks
      .filter((mark) => mark.actual)
      .map((mark) => ({
        type: 'Feature' as const,
        properties: { markId: mark.id },
        geometry: {
          type: 'LineString' as const,
          coordinates: [[...mark.target], [...(mark.actual ?? mark.target)]],
        },
      })),
  }

  const courseOrder = ['start-rc', 'start-pin', 'mark-1', 'mark-1a', 'mark-2', 'mark-3s', 'mark-3p']
  const ordered = courseOrder
    .map((id) => marks.find((mark) => mark.id === id))
    .filter((mark): mark is CourseMark => Boolean(mark))
    .map((mark) => [...(mark.actual ?? mark.target)])

  const course: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features:
      ordered.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: ordered },
            },
          ]
        : [],
  }

  return { points, targetLinks, course }
}

export function MapView({
  marks,
  boats,
  wind,
  selectedMarkId,
  onSelectMark,
  onUseCurrentLocation,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRefs = useRef<maplibregl.Marker[]>([])
  const [mapReady, setMapReady] = useState(false)
  const [locationError, setLocationError] = useState<string>()
  const features = useMemo(() => buildCourseFeatures(marks), [marks])
  const initialFeaturesRef = useRef(features)
  const selectedMark = marks.find((mark) => mark.id === selectedMarkId)
  const selfBoat = boats.find((boat) => boat.isSelf)

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
      element.innerHTML = `<span class="boat-marker__arrow" style="transform: rotate(${boat.courseDegrees ?? 0}deg)">▲</span><span class="boat-marker__label">${boat.assignment}</span>`
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
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next: LngLat = [position.coords.longitude, position.coords.latitude]
        setLocationError(undefined)
        onUseCurrentLocation(next)
        mapRef.current?.flyTo({ center: [...next], zoom: 15.5 })
      },
      () => setLocationError('位置情報を取得できません。端末の許可を確認してください'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 12_000 },
    )
  }

  return (
    <section className="map-shell" aria-label="レース海面地図">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-topbar glass-panel">
        <div className="map-topbar__primary">
          <span className="eyebrow"><Radio size={13} /> 海面A・LIVE</span>
          <strong>江の島沖 コース設営</strong>
        </div>
        <div className="map-weather">
          <Wind size={17} />
          <span><strong>{wind.directionDegrees}°</strong> / {wind.speedKnots.toFixed(1)} kt</span>
          <span className="freshness">42秒前</span>
        </div>
      </div>

      <div className="map-actions" aria-label="地図操作">
        <button type="button" className="map-action" onClick={fitCourse}>
          <Crosshair size={18} />
          <span>全体</span>
        </button>
        <button type="button" className="map-action map-action--primary" onClick={locate}>
          <LocateFixed size={18} />
          <span>現在地</span>
        </button>
      </div>

      <div className="map-legend glass-panel" aria-label="地図凡例">
        <span><i className="legend-target" /> 計画</span>
        <span><i className="legend-actual" /> 投下地点</span>
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

      {selectedMark && selfBoat && (
        <article className="selected-mark glass-panel">
          <div className="selected-mark__icon"><MapPin size={19} /></div>
          <div>
            <span className="eyebrow">{selectedMark.label}</span>
            <strong>{formatDistance(distanceMetres(selfBoat.position, selectedMark.actual ?? selectedMark.target))}</strong>
            <small>
              方位 {Math.round(bearingDegrees(selfBoat.position, selectedMark.actual ?? selectedMark.target))}°
              {selectedMark.actual && `・計画差 ${Math.round(distanceMetres(selectedMark.target, selectedMark.actual))}m`}
            </small>
          </div>
        </article>
      )}

      {locationError && <div className="map-error" role="alert">{locationError}</div>}
      <div className="map-offline-grid" aria-hidden="true" />
      <div className="map-watermark"><Waves size={14} /> 海上運営支援・航海用ではありません</div>
    </section>
  )
}
