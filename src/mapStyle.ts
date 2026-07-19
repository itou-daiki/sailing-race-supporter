import type { StyleSpecification } from 'maplibre-gl'

export const GSI_MAP_STYLE: StyleSpecification = {
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
