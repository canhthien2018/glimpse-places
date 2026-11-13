// A minimal Mapbox Vector Tile (v2) encoder for one layer of points: all this data needs.
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

export const EXTENT = 4096

class Writer {
  constructor() {
    this.buf = new Uint8Array(1024)
    this.pos = 0
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }
  varint(value) {
    this.ensure(10)
    let v = value
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80
      v = Math.floor(v / 128)
    }
    this.buf[this.pos++] = v
  }
  tag(field, wire) {
    this.varint((field << 3) | wire)
  }
  bytes(field, data) {
    this.tag(field, 2)
    this.varint(data.length)
    this.ensure(data.length)
    this.buf.set(data, this.pos)
    this.pos += data.length
  }
  string(field, text) {
    this.bytes(field, encoder.encode(text))
  }
  packed(field, values) {
    const inner = new Writer()
    for (const v of values) inner.varint(v)
    this.bytes(field, inner.finish())
  }
  finish() {
    return this.buf.subarray(0, this.pos)
  }
}

const encoder = new TextEncoder()
const zigzag = (n) => (n << 1) ^ (n >> 31)

// features: [{ x, y, props: { key: string } }] with x, y in tile pixels (0..EXTENT). Empty or missing
// property values are left out.
export function encodeTile(layerName, features) {
  const keys = []
  const keyIndex = new Map()
  const values = []
  const valueIndex = new Map()
  const layer = new Writer()
  layer.varint((15 << 3) | 0)
  layer.varint(2) // version
  layer.string(1, layerName)
  for (const f of features) {
    const tags = []
    for (const [key, value] of Object.entries(f.props)) {
      if (value === null || value === undefined || value === '') continue
      let k = keyIndex.get(key)
      if (k === undefined) {
        k = keys.push(key) - 1
        keyIndex.set(key, k)
      }
      let v = valueIndex.get(value)
      if (v === undefined) {
        v = values.push(value) - 1
        valueIndex.set(value, v)
      }
      tags.push(k, v)
    }
    const feature = new Writer()
    feature.packed(2, tags)
    feature.tag(3, 0)
    feature.varint(1) // POINT
    feature.packed(4, [(1 & 0x7) | (1 << 3), zigzag(f.x), zigzag(f.y)]) // MoveTo, count 1
    layer.bytes(2, feature.finish())
  }
  for (const key of keys) layer.string(3, key)
  for (const value of values) {
    const v = new Writer()
    v.string(1, value)
    layer.bytes(4, v.finish())
  }
  layer.tag(5, 0)
  layer.varint(EXTENT)
  const tile = new Writer()
  tile.bytes(3, layer.finish())
  return tile.finish()
}

// Web Mercator: a point's tile at zoom z and its pixel inside that tile.
export function tileOf(lng, lat, z) {
  const n = 2 ** z
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const fx = ((lng + 180) / 360) * n
  const rad = (clamped * Math.PI) / 180
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const x = Math.min(n - 1, Math.max(0, Math.floor(fx)))
  const y = Math.min(n - 1, Math.max(0, Math.floor(fy)))
  return {
    x,
    y,
    px: Math.min(EXTENT - 1, Math.max(0, Math.round((fx - x) * EXTENT))),
    py: Math.min(EXTENT - 1, Math.max(0, Math.round((fy - y) * EXTENT))),
  }
}
