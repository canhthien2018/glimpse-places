// Builds the Glimpse map's eateries, cafés and bars from Overture Maps Places: one query over the latest
// release, cleaned and de-duplicated, encoded as zoom-14 vector tiles and packed into PMTiles files of at
// most ~85 MB each (GitHub Pages refuses bigger files), plus manifest.json saying which file covers which
// part of the world. Run monthly by .github/workflows/build.yml; locally: `node build.mjs --bbox w,s,e,n`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { DuckDBInstance } from '@duckdb/node-api'
import { CLASS_SQL } from './lib/categories.mjs'
import { encodeTile } from './lib/mvt.mjs'
import { writePmtiles } from './lib/pmtiles.mjs'

const ZOOM = 14
const LAYER = 'venues'
const MAX_FILE_BYTES = 80 * 1024 * 1024
const MIN_CONFIDENCE = 0.7
const ATTRIBUTION = '<a href="https://overturemaps.org" target="_blank" rel="noreferrer">© Overture Maps Foundation</a>'

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] ?? '']] : [])),
)
const OUT = args.out || 'dist'

async function latestRelease() {
  const res = await fetch('https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/')
  const xml = await res.text()
  const releases = [...xml.matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)].map((m) => m[1]).sort()
  if (!releases.length) throw new Error('no Overture release found')
  return releases.at(-1)
}

const release = args.release || (await latestRelease())
console.log(`Overture release ${release}`)
const source = `read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*')`
const bbox = args.bbox ? args.bbox.split(',').map(Number) : null
const where = bbox
  ? `AND bbox.xmin BETWEEN ${bbox[0]} AND ${bbox[2]} AND bbox.ymin BETWEEN ${bbox[1]} AND ${bbox[3]}`
  : ''

const db = await DuckDBInstance.create(':memory:')
const c = await db.connect()
await c.run(`INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET preserve_insertion_order=false;`)

// Names that are an address or an advert, not a place: long, a phone number, a list of commas.
const junk = `length(name) < 2 OR length(name) > 60
  OR regexp_matches(name, '\\d{8,}|\\d{3,4}[ .-]\\d{3}[ .-]\\d{3,4}')
  OR length(name) - length(replace(name, ',', '')) >= 2`

const started = Date.now()
await c.run(`CREATE TABLE places AS
WITH raw AS (
  SELECT id, trim(names.primary) AS name, ${CLASS_SQL} AS class, confidence,
    bbox.xmin AS lng, bbox.ymin AS lat,
    nullif(trim(addresses[1].freeform), '') AS addr,
    phones[1] AS phone,
    list_filter(websites, lambda w: w ILIKE 'http%')[1] AS web,
    regexp_extract(list_filter(socials, lambda s: s ILIKE '%facebook.com/%')[1], 'facebook\\.com/([A-Za-z0-9._-]+)', 1) AS fb
  FROM ${source}
  WHERE confidence >= ${MIN_CONFIDENCE}
    AND coalesce(operating_status, 'open') = 'open'
    AND names.primary IS NOT NULL
    ${where}
)
SELECT * FROM raw
WHERE class IS NOT NULL AND NOT (${junk})
-- The same place from two sources: same name (folded) within ~50 m, keep the surer one.
QUALIFY row_number() OVER (
  PARTITION BY lower(regexp_replace(strip_accents(name), '[^A-Za-z0-9]', '', 'g')), round(lat * 2000), round(lng * 2000)
  ORDER BY confidence DESC, id) = 1`)
const total = (await c.runAndReadAll('SELECT count(*)::INTEGER n FROM places')).getRowObjectsJson()[0].n
console.log(`${total} places in ${Math.round((Date.now() - started) / 1000)} s`)

// Web Mercator tile and pixel at zoom 14, the same arithmetic as lib/mvt.mjs tileOf.
const N = 2 ** ZOOM
const fx = `((lng + 180) / 360 * ${N})`
const latc = `radians(least(85.05112878, greatest(-85.05112878, lat)))`
const fy = `((1 - ln(tan(${latc}) + 1 / cos(${latc})) / pi()) / 2 * ${N})`
const result = await c.stream(`SELECT
    least(${N - 1}, greatest(0, floor(${fx})))::INTEGER AS x,
    least(${N - 1}, greatest(0, floor(${fy})))::INTEGER AS y,
    ${fx} AS fx, ${fy} AS fy,
    id, name, class, addr, phone, web, fb
  FROM places ORDER BY x, y`)

const tiles = []
let current = null
const flush = () => {
  if (current) tiles.push({ z: ZOOM, x: current.x, y: current.y, data: gzipSync(encodeTile(LAYER, current.features), { level: 9 }) })
}
const clean = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)
for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
  for (const [x, y, rx, ry, id, name, cls, addr, phone, web, fb] of chunk.getRows()) {
    if (!current || current.x !== x || current.y !== y) {
      flush()
      current = { x, y, features: [] }
    }
    current.features.push({
      x: Math.min(4095, Math.max(0, Math.round((rx - x) * 4096))),
      y: Math.min(4095, Math.max(0, Math.round((ry - y) * 4096))),
      props: { id, name, class: cls, addr: clean(addr, 120), phone: clean(phone, 30), web: clean(web, 200), fb: clean(fb, 100) },
    })
  }
}
flush()
console.log(`${tiles.length} tiles, ${(tiles.reduce((s, t) => s + t.data.length, 0) / 1e6).toFixed(1)} MB`)

// Split the world into quadtree cells until each fits one file.
const cells = []
function split(z, x, y, members) {
  const bytes = members.reduce((s, t) => s + t.data.length, 0)
  if (!members.length) return
  if (bytes <= MAX_FILE_BYTES || z === ZOOM) {
    cells.push({ z, x, y, members, bytes })
    return
  }
  const shift = ZOOM - z - 1
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const cx = 2 * x + dx
    const cy = 2 * y + dy
    split(z + 1, cx, cy, members.filter((t) => t.x >> shift === cx && t.y >> shift === cy))
  }
}
split(0, 0, 0, tiles)

const lngOf = (x, z) => (x / 2 ** z) * 360 - 180
const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const manifest = { release, built: new Date().toISOString(), zoom: ZOOM, layer: LAYER, places: total, attribution: ATTRIBUTION, cells: [] }
for (const cell of cells) {
  const file = `venues-${cell.z}-${cell.x}-${cell.y}.pmtiles`
  const bounds = [lngOf(cell.x, cell.z), latOf(cell.y + 1, cell.z), lngOf(cell.x + 1, cell.z), latOf(cell.y, cell.z)]
  const archive = writePmtiles(cell.members, {
    minZoom: ZOOM,
    maxZoom: ZOOM,
    bounds,
    metadata: { name: 'Glimpse venues', attribution: ATTRIBUTION, release, vector_layers: [{ id: LAYER, fields: { id: 'String', name: 'String', class: 'String', addr: 'String', phone: 'String', web: 'String', fb: 'String' } }] },
  })
  writeFileSync(`${OUT}/${file}`, archive)
  manifest.cells.push({ z: cell.z, x: cell.x, y: cell.y, file, bytes: archive.length })
  console.log(`${file}: ${cell.members.length} tiles, ${(archive.length / 1e6).toFixed(1)} MB`)
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1))
writeFileSync(
  `${OUT}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Glimpse venues</title><p>Eateries, cafés and bars for the Glimpse map, from <a href="https://overturemaps.org">Overture Maps Places</a> (release ${release}, CDLA Permissive 2.0 / Apache 2.0). See <a href="manifest.json">manifest.json</a>.</p>`,
)
const sum = manifest.cells.reduce((s, c) => s + c.bytes, 0)
console.log(`${manifest.cells.length} files, ${(sum / 1e6).toFixed(1)} MB in all`)
if (sum > 950 * 1024 * 1024) throw new Error('over the 1 GB a GitHub Pages site may hold')
