#!/usr/bin/env python3
"""Builds the small street-map test fixture: apps/web/e2e/fixtures/map-fixture.pmtiles.

The fixture is SYNTHETIC: a grid of made-up roads named "Fixture Rd ...", plus labels for a
few Central Texas towns at their approximate positions. It is not map data and must never be
shown as real streets; its attribution says so. Real coverage is an OpenStreetMap-derived
extract that the operator provisions (docs/engineering/MAP.md).

It uses the Protomaps basemap layer names and attributes (earth, water, roads, places), so the
same style draws the fixture and a real extract.

    python3 -m pip install pmtiles mapbox-vector-tile
    python3 scripts/map/make-fixture.py apps/web/e2e/fixtures/map-fixture.pmtiles
"""

import gzip
import warnings
import math
import sys

import mapbox_vector_tile
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.ops import transform

warnings.filterwarnings("ignore", category=DeprecationWarning)

WEST, SOUTH, EAST, NORTH = -98.6, 29.85, -97.0, 31.25
MAX_ZOOM = 12
EXTENT = 4096
BUFFER = 64

# Approximate town centres, for labels only.
TOWNS = [
    ("Austin", 30.267, -97.743, 4),
    ("Round Rock", 30.508, -97.679, 8),
    ("Georgetown", 30.633, -97.678, 8),
    ("San Marcos", 29.883, -97.941, 8),
    ("Bastrop", 30.110, -97.315, 9),
    ("Taylor", 30.571, -97.409, 9),
    ("Marble Falls", 30.578, -98.273, 9),
    ("Dripping Springs", 30.190, -98.087, 9),
    ("Wimberley", 29.997, -98.099, 9),
    ("Blanco", 30.098, -98.421, 9),
    ("Spicewood", 30.475, -98.157, 10),
]


def frange(start, stop, step):
    n = int(round((stop - start) / step))
    return [round(start + i * step, 6) for i in range(n + 1)]


def features():
    yield "earth", box(WEST, SOUTH, EAST, NORTH), {"kind": "earth"}, 0
    lake = Polygon([(-98.02, 30.40), (-97.95, 30.43), (-97.90, 30.40), (-97.93, 30.36), (-98.00, 30.37)])
    yield "water", lake, {"kind": "lake", "name": "Fixture Lake"}, 6
    for i, lng in enumerate(frange(WEST, EAST, 0.1)):
        yield "roads", LineString([(lng, SOUTH), (lng, NORTH)]), {"kind": "major_road", "name": f"Fixture Rd {100 + i}", "min_zoom": 7}, 7
    for i, lat in enumerate(frange(SOUTH, NORTH, 0.1)):
        yield "roads", LineString([(WEST, lat), (EAST, lat)]), {"kind": "major_road", "name": f"Fixture Rd {200 + i}", "min_zoom": 7}, 7
    for i, lng in enumerate(frange(WEST, EAST, 0.02)):
        if round(lng * 10, 6) % 1:
            yield "roads", LineString([(lng, SOUTH), (lng, NORTH)]), {"kind": "minor_road", "kind_detail": "residential", "name": f"Fixture Ln {i}", "min_zoom": 11}, 11
    for i, lat in enumerate(frange(SOUTH, NORTH, 0.02)):
        if round(lat * 10, 6) % 1:
            yield "roads", LineString([(WEST, lat), (EAST, lat)]), {"kind": "minor_road", "kind_detail": "residential", "name": f"Fixture St {i}", "min_zoom": 11}, 11
    yield "roads", LineString([(WEST, SOUTH + 0.2), (EAST, NORTH - 0.2)]), {"kind": "highway", "name": "Fixture Hwy 1", "min_zoom": 5}, 5
    for name, lat, lng, min_zoom in TOWNS:
        yield "places", Point(lng, lat), {"kind": "locality", "name": name, "min_zoom": min_zoom, "population_rank": 14 - min_zoom}, min_zoom


def to_tile(z, x, y):
    n = 2**z

    def project(lng, lat, *_):
        px = (lng + 180) / 360 * n
        lat_r = math.radians(lat)
        py = (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n
        return (px - x) * EXTENT, (py - y) * EXTENT

    return project


def tile_range(z):
    n = 2**z

    def xy(lng, lat):
        lat_r = math.radians(lat)
        return int((lng + 180) / 360 * n), int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)

    x0, y0 = xy(WEST, NORTH)
    x1, y1 = xy(EAST, SOUTH)
    return range(x0, x1 + 1), range(y0, y1 + 1)


def main(out):
    feats = list(features())
    tiles = {}
    for z in range(MAX_ZOOM + 1):
        xs, ys = tile_range(z)
        for x in xs:
            for y in ys:
                clip = box(-BUFFER, -BUFFER, EXTENT + BUFFER, EXTENT + BUFFER)
                layers = {}
                for layer, geom, props, min_zoom in feats:
                    if z < min_zoom:
                        continue
                    g = transform(to_tile(z, x, y), geom).intersection(clip)
                    if g.is_empty:
                        continue
                    layers.setdefault(layer, []).append({"geometry": mapping(g), "properties": props})
                if not layers:
                    continue
                data = mapbox_vector_tile.encode(
                    [{"name": k, "features": v} for k, v in layers.items()],
                    default_options={"y_coord_down": True, "extents": EXTENT},
                )
                tiles[zxy_to_tileid(z, x, y)] = gzip.compress(data, mtime=0)

    with write(out) as writer:
        for tile_id in sorted(tiles):
            writer.write_tile(tile_id, tiles[tile_id])
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_lon_e7": int(WEST * 1e7),
                "min_lat_e7": int(SOUTH * 1e7),
                "max_lon_e7": int(EAST * 1e7),
                "max_lat_e7": int(NORTH * 1e7),
                "center_zoom": 9,
                "center_lon_e7": int((WEST + EAST) / 2 * 1e7),
                "center_lat_e7": int((SOUTH + NORTH) / 2 * 1e7),
            },
            {
                "name": "Aerowise test fixture",
                "description": "Synthetic test map. Not real streets.",
                "attribution": "Test map: synthetic streets, not real",
                "vector_layers": [
                    {"id": "earth", "fields": {}},
                    {"id": "water", "fields": {}},
                    {"id": "roads", "fields": {}},
                    {"id": "places", "fields": {}},
                ],
            },
        )
    print(f"{out}: {len(tiles)} tiles, zoom 0-{MAX_ZOOM}, bounds {WEST},{SOUTH},{EAST},{NORTH}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "apps/web/e2e/fixtures/map-fixture.pmtiles")
