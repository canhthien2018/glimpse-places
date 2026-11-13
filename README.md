# glimpse-places

Eateries, cafés and bars for the [Glimpse](https://github.com/canhthien2018) map, from
[Overture Maps Places](https://docs.overturemaps.org/guides/places/), served as static files on GitHub Pages.

OpenStreetMap, which draws the base map, is missing most small eateries in many countries (in Vietnam, 10 to
70 times fewer than Overture, whose places come mostly from businesses' own pages). This repository packs
Overture's into map tiles the app reads directly: no server, no database, no key.

## What is built

`build.mjs` runs once a month (`.github/workflows/build.yml`, or by hand) over the latest Overture release:

1. **Select** places whose category is eating or drinking (`lib/categories.mjs`, mapped to the OpenMapTiles
   class names the app already draws), with confidence ≥ 0.7 and not closed.
2. **Clean**: drop names that are an address or an advert; keep one of the same name within ~50 m.
3. **Tile**: zoom-14 vector tiles, one layer `venues` with `id` (Overture id), `name`, `class`, `addr`,
   `phone`, `web`, `fb` (`lib/mvt.mjs`).
4. **Pack** into [PMTiles](https://docs.protomaps.com/pmtiles/) (`lib/pmtiles.mjs`), split into quadtree cells of
   at most ~85 MB (GitHub refuses files over 100 MB), with `manifest.json` listing which file covers which cell.

The 2026-10-21 release gave 6.27 million places in 28 files, 704 MB in all (a Pages site may hold 1 GB).

## Who reads it

- The app's map (`frontend/src/components/map/venueTiles.ts`): a MapLibre protocol picks the file for each tile;
  the `pmtiles` library fetches just that tile with an HTTP range request.
- The app's API (`backend/src/Glimpse.Api/Services/VenueTiles.cs`): reads the tile around a point to check a venue
  a post is tagged at, and for the venue's card. Venue keys are `ovt:<Overture id>`, stable across releases.

Change the tile schema or the classes only together with those two.

## Run locally

```
npm install
npm test
node build.mjs --bbox 102.1,8.4,109.5,23.4 --out dist   # Vietnam only, about a minute
node build.mjs --out dist                              # the world, about 15 minutes and 6 GB of memory
```

## Licence

Overture Maps Places data is © Overture Maps Foundation, under CDLA Permissive 2.0 and Apache 2.0 (by source).
No OpenStreetMap data is included.
