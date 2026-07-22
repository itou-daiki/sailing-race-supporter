import { bearingDegrees, distanceMetres } from './course'
import type { LngLat } from './domain'
import { destinationPoint } from '../shared/courseGeometry'
import { VectorTile } from '@mapbox/vector-tile'
import Protobuf from 'pbf'

const DEM_ZOOM = 14
const TILE_SIZE = 256
const EARTH_CIRCUMFERENCE_METRES = 40_075_016.686
const DEFAULT_CLEARANCE_METRES = 300

type FetchLike = typeof fetch

interface DemTile {
  land: Uint8Array
}

export type CoastClearanceAssessment =
  | { status: 'safe'; minimumMetres: number }
  | { status: 'unsafe'; minimumMetres: number; nearestCoursePoint: LngLat; nearestLandPoint: LngLat }
  | { status: 'unavailable' }

const sharedTileCache = new Map<string, Promise<DemTile | undefined>>()

function worldPixel(position: LngLat): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** DEM_ZOOM
  const latitude = Math.min(85.05112878, Math.max(-85.05112878, position[1]))
  const sinLatitude = Math.sin((latitude * Math.PI) / 180)
  return {
    x: ((position[0] + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  }
}

function lngLatFromWorldPixel(x: number, y: number): LngLat {
  const scale = TILE_SIZE * 2 ** DEM_ZOOM
  const longitude = (x / scale) * 360 - 180
  const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI
  return [longitude, latitude]
}

function metresPerPixel(latitude: number): number {
  return (Math.cos((latitude * Math.PI) / 180) * EARTH_CIRCUMFERENCE_METRES) / (TILE_SIZE * 2 ** DEM_ZOOM)
}

function tileKey(tileX: number, tileY: number): string {
  return `${DEM_ZOOM}/${tileX}/${tileY}`
}

function parseDemTile(text: string): DemTile | undefined {
  const rows = text.trimEnd().split('\n')
  if (rows.length !== TILE_SIZE) return undefined
  const land = new Uint8Array(TILE_SIZE * TILE_SIZE)
  for (let y = 0; y < TILE_SIZE; y += 1) {
    const values = rows[y].split(',')
    if (values.length < TILE_SIZE) return undefined
    for (let x = 0; x < TILE_SIZE; x += 1) {
      land[y * TILE_SIZE + x] = values[x] === 'e' ? 0 : 1
    }
  }
  return { land }
}

async function confirmTileIsOpenWater(
  tileX: number,
  tileY: number,
  fetcher: FetchLike,
): Promise<DemTile | undefined> {
  try {
    const response = await fetcher(
      `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${DEM_ZOOM}/${tileX}/${tileY}.pbf`,
      { cache: 'force-cache' },
    )
    if (!response.ok) return undefined
    const tile = new VectorTile(new Protobuf(new Uint8Array(await response.arrayBuffer())))
    const layerNames = Object.keys(tile.layers)
    const openWaterLayers = new Set(['waterarea', 'searoute'])
    const isOpenWater = layerNames.includes('waterarea') && layerNames.every((layer) => openWaterLayers.has(layer))
    return isOpenWater ? { land: new Uint8Array(TILE_SIZE * TILE_SIZE) } : undefined
  } catch {
    return undefined
  }
}

function loadDemTile(tileX: number, tileY: number, fetcher: FetchLike): Promise<DemTile | undefined> {
  const key = tileKey(tileX, tileY)
  const load = async () => {
    try {
      const confirmedOpenWater = await confirmTileIsOpenWater(tileX, tileY, fetcher)
      if (confirmedOpenWater) return confirmedOpenWater
      const response = await fetcher(`https://cyberjapandata.gsi.go.jp/xyz/dem/${key}.txt`, { cache: 'force-cache' })
      if (!response.ok) return undefined
      return parseDemTile(await response.text())
    } catch {
      return undefined
    }
  }
  if (fetcher !== fetch) return load()
  const cached = sharedTileCache.get(key)
  if (cached) return cached
  const promise = load()
  sharedTileCache.set(key, promise)
  return promise
}

export function sampleCoursePath(path: readonly LngLat[], intervalMetres = 45): LngLat[] {
  if (path.length < 2) return [...path]
  const samples: LngLat[] = []
  path.slice(0, -1).forEach((from, index) => {
    const to = path[index + 1]
    const segmentLength = distanceMetres(from, to)
    const divisions = Math.max(1, Math.ceil(segmentLength / intervalMetres))
    for (let step = 0; step < divisions; step += 1) {
      const ratio = step / divisions
      samples.push([
        from[0] + (to[0] - from[0]) * ratio,
        from[1] + (to[1] - from[1]) * ratio,
      ])
    }
  })
  samples.push(path[path.length - 1])
  return samples
}

export async function assessCoastClearance(
  coursePath: readonly LngLat[],
  clearanceMetres = DEFAULT_CLEARANCE_METRES,
  fetcher: FetchLike = fetch,
  additionalPoints: readonly LngLat[] = [],
): Promise<CoastClearanceAssessment> {
  if (!coursePath.length && !additionalPoints.length) return { status: 'unavailable' }
  const samples = [...sampleCoursePath(coursePath), ...additionalPoints]
  const requiredTiles = new Map<string, { x: number; y: number }>()
  samples.forEach((position) => {
    const pixel = worldPixel(position)
    const radius = Math.ceil(clearanceMetres / metresPerPixel(position[1])) + 1
    const minTileX = Math.floor((pixel.x - radius) / TILE_SIZE)
    const maxTileX = Math.floor((pixel.x + radius) / TILE_SIZE)
    const minTileY = Math.floor((pixel.y - radius) / TILE_SIZE)
    const maxTileY = Math.floor((pixel.y + radius) / TILE_SIZE)
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        requiredTiles.set(tileKey(tileX, tileY), { x: tileX, y: tileY })
      }
    }
  })

  const tiles = new Map<string, DemTile>()
  const loaded = await Promise.all([...requiredTiles.entries()].map(async ([key, tile]) => [key, await loadDemTile(tile.x, tile.y, fetcher)] as const))
  if (loaded.some(([, tile]) => !tile)) return { status: 'unavailable' }
  loaded.forEach(([key, tile]) => {
    if (tile) tiles.set(key, tile)
  })

  let nearestDistance = Number.POSITIVE_INFINITY
  let nearestCoursePoint: LngLat | undefined
  let nearestLandPoint: LngLat | undefined
  for (const position of samples) {
    const pixel = worldPixel(position)
    const resolution = metresPerPixel(position[1])
    const radius = Math.ceil(clearanceMetres / resolution)
    const centerX = Math.round(pixel.x)
    const centerY = Math.round(pixel.y)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const distance = Math.hypot(offsetX, offsetY) * resolution
        if (distance >= Math.min(clearanceMetres, nearestDistance)) continue
        const globalX = centerX + offsetX
        const globalY = centerY + offsetY
        const tileX = Math.floor(globalX / TILE_SIZE)
        const tileY = Math.floor(globalY / TILE_SIZE)
        const tile = tiles.get(tileKey(tileX, tileY))
        if (!tile) continue
        const localX = ((globalX % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
        const localY = ((globalY % TILE_SIZE) + TILE_SIZE) % TILE_SIZE
        if (!tile.land[localY * TILE_SIZE + localX]) continue
        nearestDistance = distance
        nearestCoursePoint = position
        nearestLandPoint = lngLatFromWorldPixel(globalX, globalY)
      }
    }
  }

  if (!nearestCoursePoint || !nearestLandPoint) return { status: 'safe', minimumMetres: clearanceMetres }
  return { status: 'unsafe', minimumMetres: Math.max(0, nearestDistance), nearestCoursePoint, nearestLandPoint }
}

export async function findCoastClearSignalPosition(
  initialPosition: LngLat,
  courseGeometryAt: (signalPosition: LngLat) => {
    path: readonly LngLat[]
    additionalPoints?: readonly LngLat[]
  },
  clearanceMetres = DEFAULT_CLEARANCE_METRES,
): Promise<{ position: LngLat; movedMetres: number; assessment: CoastClearanceAssessment }> {
  let position = initialPosition
  let geometry = courseGeometryAt(position)
  let assessment = await assessCoastClearance(geometry.path, clearanceMetres, fetch, geometry.additionalPoints)
  for (let attempt = 0; attempt < 5 && assessment.status === 'unsafe'; attempt += 1) {
    // If a remote mark overlaps land, a one-pixel land-to-course bearing is
    // unstable. Move that mark back toward the signal boat, which is the known
    // course anchor. For a shoreline close to the signal boat itself, retain
    // the direct land-to-course bearing.
    const distanceFromAnchor = distanceMetres(assessment.nearestCoursePoint, position)
    const bearingAwayFromLand = distanceFromAnchor > 50
      ? bearingDegrees(assessment.nearestCoursePoint, position)
      : bearingDegrees(assessment.nearestLandPoint, assessment.nearestCoursePoint)
    const shiftMetres = Math.max(80, clearanceMetres - assessment.minimumMetres + 60)
    position = [...destinationPoint(position, shiftMetres, bearingAwayFromLand)] as LngLat
    geometry = courseGeometryAt(position)
    assessment = await assessCoastClearance(geometry.path, clearanceMetres, fetch, geometry.additionalPoints)
  }
  return { position, movedMetres: distanceMetres(initialPosition, position), assessment }
}
