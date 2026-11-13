import { gzipSync } from 'node:zlib'

// A PMTiles v3 writer: one file of gzip'd vector tiles that a browser (or the API) reads with HTTP
// range requests, so a static host serves the whole map. Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

const HEADER_BYTES = 127
const ROOT_MAX = 16384 - HEADER_BYTES
const LEAF_SIZE = 4096

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0]
      xy[1] = n - 1 - xy[1]
    }
    const t = xy[0]
    xy[0] = xy[1]
    xy[1] = t
  }
}

// The tile's position on the Hilbert curve, after every tile of the zooms above it.
export function zxyToTileId(z, x, y) {
  let acc = 0
  for (let a = 0; a < z; a++) acc += 2 ** (2 * a)
  const xy = [x, y]
  let d = 0
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0
    const ry = (xy[1] & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    rotate(s, xy, rx, ry)
  }
  return acc + d
}

function varints(values) {
  const out = []
  for (let v of values) {
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
  }
  return out
}

// entries: [{ tileId, offset, length, runLength }] sorted by tileId.
function serializeDirectory(entries) {
  const out = varints([entries.length])
  let last = 0
  for (const e of entries) {
    out.push(...varints([e.tileId - last]))
    last = e.tileId
  }
  for (const e of entries) out.push(...varints([e.runLength]))
  for (const e of entries) out.push(...varints([e.length]))
  entries.forEach((e, i) => {
    const prev = entries[i - 1]
    out.push(...varints([i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1]))
  })
  return gzipSync(Buffer.from(out))
}

// Root directory, and leaves when every entry doesn't fit in the first 16 KiB.
function directories(entries, rootMax) {
  const root = serializeDirectory(entries)
  if (root.length <= rootMax) return { root, leaves: Buffer.alloc(0) }
  for (let size = Math.min(LEAF_SIZE, Math.max(1, Math.ceil(entries.length / 64))); ; size *= 2) {
    const rootEntries = []
    const leafParts = []
    let offset = 0
    for (let i = 0; i < entries.length; i += size) {
      const leaf = serializeDirectory(entries.slice(i, i + size))
      rootEntries.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 })
      leafParts.push(leaf)
      offset += leaf.length
    }
    const rootDir = serializeDirectory(rootEntries)
    if (rootDir.length <= rootMax) return { root: rootDir, leaves: Buffer.concat(leafParts) }
  }
}

// tiles: [{ z, x, y, data }] (data already gzip'd). Returns the whole file. rootMax: only for tests, to force
// leaf directories on a small archive.
export function writePmtiles(tiles, { minZoom, maxZoom, bounds, metadata, rootMax = ROOT_MAX }) {
  const sorted = tiles.map((t) => ({ ...t, tileId: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.tileId - b.tileId)
  const entries = []
  let offset = 0
  for (const t of sorted) {
    entries.push({ tileId: t.tileId, offset, length: t.data.length, runLength: 1 })
    offset += t.data.length
  }
  const { root, leaves } = directories(entries, rootMax)
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)))
  const rootOffset = HEADER_BYTES
  const metaOffset = rootOffset + root.length
  const leavesOffset = metaOffset + meta.length
  const dataOffset = leavesOffset + leaves.length

  const header = Buffer.alloc(HEADER_BYTES)
  header.write('PMTiles', 0, 'ascii')
  header.writeUInt8(3, 7)
  const u64 = (pos, value) => header.writeBigUInt64LE(BigInt(value), pos)
  u64(8, rootOffset)
  u64(16, root.length)
  u64(24, metaOffset)
  u64(32, meta.length)
  u64(40, leavesOffset)
  u64(48, leaves.length)
  u64(56, dataOffset)
  u64(64, offset)
  u64(72, entries.length) // addressed tiles
  u64(80, entries.length) // tile entries
  u64(88, entries.length) // tile contents
  header.writeUInt8(1, 96) // clustered: data in tileId order
  header.writeUInt8(2, 97) // internal compression: gzip
  header.writeUInt8(2, 98) // tile compression: gzip
  header.writeUInt8(1, 99) // tile type: mvt
  header.writeUInt8(minZoom, 100)
  header.writeUInt8(maxZoom, 101)
  const e7 = (v) => Math.round(v * 1e7)
  header.writeInt32LE(e7(bounds[0]), 102)
  header.writeInt32LE(e7(bounds[1]), 106)
  header.writeInt32LE(e7(bounds[2]), 110)
  header.writeInt32LE(e7(bounds[3]), 114)
  header.writeUInt8(maxZoom, 118)
  header.writeInt32LE(e7((bounds[0] + bounds[2]) / 2), 119)
  header.writeInt32LE(e7((bounds[1] + bounds[3]) / 2), 123)

  return Buffer.concat([header, root, meta, leaves, ...sorted.map((t) => t.data)])
}
