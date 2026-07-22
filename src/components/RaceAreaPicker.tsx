import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl'
import { Check, MapPin, Move } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { GSI_MAP_STYLE } from '../mapStyle'

interface RaceAreaPickerProps {
  longitude: number
  latitude: number
  onChange: (center: { longitude: number; latitude: number }) => void
}

export function RaceAreaPicker({ longitude, latitude, onChange }: RaceAreaPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap>(null)
  const markerRef = useRef<Marker>(null)
  const onChangeRef = useRef(onChange)
  const initialCenterRef = useRef({ longitude, latitude })
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!containerRef.current || typeof WebGLRenderingContext === 'undefined') return
    try {
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: GSI_MAP_STYLE,
        center: [initialCenterRef.current.longitude, initialCenterRef.current.latitude],
        zoom: 12.5,
        attributionControl: false,
      })
      const marker = new maplibregl.Marker({ color: '#0674d5', draggable: false })
        .setLngLat([initialCenterRef.current.longitude, initialCenterRef.current.latitude])
        .addTo(map)
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
      marker.on('dragend', () => {
        const next = marker.getLngLat()
        onChangeRef.current({ longitude: next.lng, latitude: next.lat })
      })
      mapRef.current = map
      markerRef.current = marker
      return () => {
        marker.remove()
        map.remove()
        markerRef.current = null
        mapRef.current = null
      }
    } catch {
      return
    }
  }, [])

  useEffect(() => {
    markerRef.current?.setDraggable(editing)
  }, [editing])

  useEffect(() => {
    markerRef.current?.setLngLat([longitude, latitude])
    mapRef.current?.easeTo({ center: [longitude, latitude], duration: 250 })
  }, [latitude, longitude])

  return (
    <div className="race-area-picker">
      <div ref={containerRef} className="race-area-picker__map" aria-label="レース海面の中心を選ぶ地図" />
      <span className="race-area-picker__guide"><MapPin size={15} /> {editing ? '青いピンを押したままドラッグ' : '通常操作は地図の移動・拡大縮小のみ'}</span>
      <button
        type="button"
        className={`race-area-picker__edit ${editing ? 'is-active' : ''}`}
        aria-pressed={editing}
        onClick={() => setEditing((current) => !current)}
      >
        {editing ? <Check size={16} /> : <Move size={16} />}
        {editing ? '位置を確定' : 'レースエリアを変える'}
      </button>
    </div>
  )
}
