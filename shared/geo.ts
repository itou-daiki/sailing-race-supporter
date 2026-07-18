const EARTH_RADIUS_METRES = 6_371_000

function radians(degrees: number): number {
  return degrees * Math.PI / 180
}

function degrees(radiansValue: number): number {
  return radiansValue * 180 / Math.PI
}

export function geodesicDistanceMetres(
  from: readonly [longitude: number, latitude: number],
  to: readonly [longitude: number, latitude: number],
): number {
  const fromLatitude = radians(from[1])
  const toLatitude = radians(to[1])
  const latitudeDifference = toLatitude - fromLatitude
  const longitudeDifference = radians(to[0] - from[0])
  const haversine = Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDifference / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

export function trueBearingDegrees(
  from: readonly [longitude: number, latitude: number],
  to: readonly [longitude: number, latitude: number],
): number {
  const fromLatitude = radians(from[1])
  const toLatitude = radians(to[1])
  const longitudeDifference = radians(to[0] - from[0])
  const y = Math.sin(longitudeDifference) * Math.cos(toLatitude)
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDifference)
  return (degrees(Math.atan2(y, x)) + 360) % 360
}

export function geodesicMidpoint(
  from: readonly [longitude: number, latitude: number],
  to: readonly [longitude: number, latitude: number],
): [longitude: number, latitude: number] {
  const fromLatitude = radians(from[1])
  const fromLongitude = radians(from[0])
  const toLatitude = radians(to[1])
  const longitudeDifference = radians(to[0] - from[0])
  const bx = Math.cos(toLatitude) * Math.cos(longitudeDifference)
  const by = Math.cos(toLatitude) * Math.sin(longitudeDifference)
  const latitude = Math.atan2(
    Math.sin(fromLatitude) + Math.sin(toLatitude),
    Math.sqrt((Math.cos(fromLatitude) + bx) ** 2 + by ** 2),
  )
  const longitude = fromLongitude + Math.atan2(by, Math.cos(fromLatitude) + bx)
  const normalizedLongitude = ((degrees(longitude) + 540) % 360) - 180
  return [normalizedLongitude, degrees(latitude)]
}
