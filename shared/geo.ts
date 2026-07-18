const EARTH_RADIUS_METRES = 6_371_000

function radians(degrees: number): number {
  return degrees * Math.PI / 180
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
