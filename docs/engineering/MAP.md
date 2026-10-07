# Street map

The office schedule and the technician app draw routes on a street map. This page covers what it uses, what it covers, what it needs on the server and how an operator installs or changes the map data. Manual deployment steps are also in [RUNBOOK.md](RUNBOOK.md#street-map-on-staging).

## What it is

- **Library:** [MapLibre GL JS](https://maplibre.org/) 6.11 (BSD-3-Clause), bundled with the web app from npm. It is loaded only when a map is on screen (about 1 MB of script, uncompressed), so the stop lists never wait for it.
- **Map data:** one [PMTiles](https://docs.protomaps.com/pmtiles/) file of vector tiles in the [Protomaps basemap](https://docs.protomaps.com/basemaps/layers) layout, read with the `pmtiles` reader (BSD-3-Clause) and drawn with the `@protomaps/basemaps` light style (BSD-3-Clause), without its icon sheet.
- **Serving:** the web app serves the file itself at `/map-data/basemap.pmtiles` with HTTP range requests (`apps/web/app/map-data/[file]/route.ts`). `MAP_TILES_FILE` is its path. No tile server, database or extra container. Label fonts (Noto Sans, SIL Open Font License, [`OFL.txt`](../../apps/web/public/map/fonts/OFL.txt)) are static files under `/map/fonts/`, copied from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets): the Latin ranges `0-255` and `8192-8447`, plus `8448-8703` (arrows) for Noto Sans Medium.
- **Nothing leaves the origin:** script, style, tiles and fonts all come from the Aerowise site. There is no geocoding, routing or traffic call from the browser. The browser tests check that every request on the schedule and technician map pages goes to the app's own origin. (The existing "Directions" button on a technician's stop still opens Google Maps when tapped; that is a link the technician chooses, not part of the embedded map.)
- **Credit:** the attribution line is always shown (not collapsed). For an OpenStreetMap-derived file it reads "© OpenStreetMap contributors (ODbL) · Protomaps", linking to <https://www.openstreetmap.org/copyright>. The file's own `attribution` metadata decides which: the test fixture says "Test map: synthetic streets, not real".

## What it shows, and what it does not

- Numbered stops in each technician's color (the same colors as the schedule columns), the start (`S`) when the company has one, done stops as hollow markers with a check, and the selected stop outlined.
- Straight dashed lines between consecutive visits, labelled with the visit order (`1 → 2`, `Start → 1`, `4 → Start`). The key under the map says they are straight lines, not roads. Travel figures in the lists and stop details are labelled as estimates from straight-line distance with an average road factor, without traffic. Nothing here changes scheduling, optimization or the travel estimate (`packages/routing`).
- Stops with no coordinates are listed under the map ("Not on the map (no location yet): stop 2"); the line skips them. Stops outside the installed map are still placed, on a blank background, and listed as outside it. Stops at the same spot fan out so each stays tappable.
- In a demo company the map is labelled "Demo: made-up locations". Demo sites keep their synthetic coordinates; a demo company's addresses only ever reach the built-in test geocoder (`DemoGatedGeocoder` in `packages/tasks/src/demo-gate.ts`), whatever geocoder the deployment has.

## When the map cannot show

No installed file, no signal, a blocked request or no WebGL: the map area says "The street map is not available right now. Every stop is still in the list." On the office schedule the stop list is always beside the map. In the technician app the List/Map switch defaults to the list, and if the map fails the full stop list appears under the note. Inspections, photos and syncing never touch the map.

**Offline:** the basemap is **not** available offline. The service worker does not cache tiles (they come from the network or not at all), so with no signal the technician sees the note and the list. The route, inspections and sync work offline as before. Offline basemap support is not implemented.

## Coverage

Real coverage is whatever file the operator installs. The recommended file for the current service area is **Central Texas**:

| | |
| --- | --- |
| Bounding box (W,S,E,N) | `-99.0,29.4,-96.8,31.2` |
| Covers | Travis, Hays, Williamson, Bastrop, Blanco, Burnet, Comal, Caldwell, Llano (south), Bell (south) and the towns the demo uses (Dripping Springs, Wimberley, Blanco, Spicewood, Austin, Round Rock, Georgetown, San Marcos) |
| Does not cover | Other counties in the county research (Denton, Ellis, Kaufman, Hill, McLennan, Grimes, Montgomery, Brazoria, SJRA): cut a larger box (below) before routing real customers there |
| Zoom | 0–15 (street level; the map zooms further by enlarging zoom 15) |
| File size | **not measured** (the extract could not be downloaded from the build sandbox). Expect hundreds of MB at zoom 15. Check it with `ls -lh` and `pmtiles show` after cutting it, and record it here. |

A real customer's stops are drawn on streets only inside that box; outside it they are still placed and listed as outside the map.

**In the repository:** only the synthetic test fixture, `apps/web/e2e/fixtures/map-fixture.pmtiles` (165 KB, zoom 0–12, box `-98.6,29.85,-97.0,31.25`). It is a grid of made-up roads named "Fixture Rd …" and town labels at approximate positions, built by [`scripts/map/make-fixture.py`](../../scripts/map/make-fixture.py). It is used by the browser tests and, outside production, when `MAP_TILES_FILE` is empty. It must not be installed on staging or production as if it were a map.

## Server needs

- Disk for the one file (both environments can share it), mounted read-only into the web container.
- No extra memory or CPU worth measuring: each map view reads a few small byte ranges (a directory, then tiles of tens of KB).
- Bandwidth: a technician opening the map downloads the map script once (cached afterwards) and a few hundred KB of tiles per view.

## Installing or changing the map (operator)

Cut the extract on any machine with the [`pmtiles` command-line tool](https://github.com/protomaps/go-pmtiles/releases) (a single binary, no account). It reads only the needed ranges of a Protomaps daily build of OpenStreetMap (ODbL), so no bulk download and no use of OpenStreetMap's own tile servers:

```sh
# Pick a recent build date from https://maps.protomaps.com/builds/ (YYYYMMDD).
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles basemap.pmtiles \
  --bbox=-99.0,29.4,-96.8,31.2 --maxzoom=15
pmtiles show basemap.pmtiles      # check bounds, zooms and that attribution mentions OpenStreetMap
ls -lh basemap.pmtiles            # record the size above
```

**Another service area:** run the same command with a box around the new area (west,south,east,north in degrees). There is one file per server, so to cover two areas cut one box around both, or replace the file. `--maxzoom=14` roughly quarters the size if disk is tight; streets stay readable when zoomed in.

Then install it on the server as in [RUNBOOK.md](RUNBOOK.md#street-map-on-staging). Replacing the file needs no redeploy: its etag changes and browsers start over with the new one.

## Licences to keep

- Map data: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). The visible credit must stay. If Aerowise ever distributes the extract itself (rather than showing maps made from it), ODbL's share-alike terms apply to that database.
- Protomaps basemap schema/style and the `pmtiles` reader: BSD-3-Clause. MapLibre GL JS: BSD-3-Clause.
- Noto Sans glyphs: SIL Open Font License 1.1 ([`OFL.txt`](../../apps/web/public/map/fonts/OFL.txt)).
