import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader as Pbf } from 'pbf'
import { PMTiles, zxyToTileId as referenceTileId } from 'pmtiles'
import { encodeTile, tileOf } from '../lib/mvt.mjs'
import { writePmtiles, zxyToTileId } from '../lib/pmtiles.mjs'

test('tile ids match the reference implementation', () => {
  for (let i = 0; i < 2000; i++) {
    const z = 1 + (i % 14)
    const x = Math.floor(Math.random() * 2 ** z)
    const y = Math.floor(Math.random() * 2 ** z)
    assert.equal(zxyToTileId(z, x, y), referenceTileId(z, x, y), `${z}/${x}/${y}`)
  }
})

// Serves a buffer like a static host answering range requests.
class BufferSource {
  constructor(buf) {
    this.buf = buf
  }
  getKey() {
    return 'mem'
  }
  async getBytes(offset, length) {
    const slice = this.buf.subarray(offset, offset + length)
    return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) }
  }
}

test('points survive the trip through the encoder and the archive', async () => {
  const places = [
    { lng: 106.6978, lat: 10.7721, id: '6aae2669-bf28-46f5-a59b-ae5be942a7ed', name: 'Phở Hòa', class: 'restaurant' },
    { lng: 106.6981, lat: 10.7725, id: 'b92c59a6-5583-4e4f-98b2-d38f6b888d0c', name: 'Cà phê Vợt', class: 'cafe', phone: '+84932870064' },
    { lng: 2.2945, lat: 48.8584, id: '0f0a1b2c-0000-4000-8000-000000000001', name: 'Le Café', class: 'cafe' },
  ]
  const byTile = new Map()
  for (const p of places) {
    const t = tileOf(p.lng, p.lat, 14)
    const key = `${t.x}/${t.y}`
    if (!byTile.has(key)) byTile.set(key, { x: t.x, y: t.y, features: [] })
    const { lng, lat, ...props } = p
    byTile.get(key).features.push({ x: t.px, y: t.py, props })
  }
  // Many tiles, so the archive needs leaf directories too.
  const filler = []
  for (let i = 0; i < 60000; i++) filler.push({ z: 14, x: (i * 7919) % 16384, y: 9000 + (i % 50), data: gzipSync(encodeTile('venues', [{ x: 1, y: 1, props: { name: `n${i}` } }])) })
  const tiles = [...byTile.values()].map((t) => ({ z: 14, x: t.x, y: t.y, data: gzipSync(encodeTile('venues', t.features)) }))
  const file = writePmtiles([...tiles, ...filler], { minZoom: 14, maxZoom: 14, bounds: [-180, -85, 180, 85], metadata: { name: 'test' } })

  const archive = new PMTiles(new BufferSource(file))
  const header = await archive.getHeader()
  assert.ok(header.leafDirectoryLength > 0, 'uses leaf directories')
  for (const p of places) {
    const t = tileOf(p.lng, p.lat, 14)
    const got = await archive.getZxy(14, t.x, t.y)
    assert.ok(got, `tile for ${p.name}`)
    const layer = new VectorTile(new Pbf(new Uint8Array(got.data))).layers.venues
    const features = Array.from({ length: layer.length }, (_, i) => layer.feature(i))
    const f = features.find((x) => x.properties.id === p.id)
    assert.ok(f, `feature ${p.name}`)
    assert.equal(f.properties.name, p.name)
    assert.equal(f.properties.class, p.class)
    const [lng, lat] = f.toGeoJSON(t.x, t.y, 14).geometry.coordinates
    assert.ok(Math.abs(lng - p.lng) < 1e-4 && Math.abs(lat - p.lat) < 1e-4, `position of ${p.name}`)
  }
  assert.equal(await archive.getZxy(14, 1, 1), undefined)
  const filled = await archive.getZxy(14, (59999 * 7919) % 16384, 9000 + (59999 % 50))
  assert.ok(filled)
})
