#!/usr/bin/env python3
"""
Builds per-theatre taxiway label anchors from OpenStreetMap and writes:
  server/navdata/cache/<folder>/airports_taxiway_labels.json

DCS rn5 taxiway centerlines carry no idents, so the names come from OSM's
aeroway=taxiway ways (designator in ref=*). A DCS airport's layout often
differs from the real one (older layouts, rebuilt airports), so an OSM
taxiway only earns a label where its centerline actually follows DCS
pavement for MIN_RUN_M continuous metres. A taxiway that merely crosses a
22 m wide DCS taxiway overlaps it by roughly 20-30 m, so a run well past
that means the two are the same strip of pavement. Where DCS and the real
airport disagree, the label just doesn't appear.

Source data is Geofabrik's regional .osm.pbf extracts. Which extracts to
fetch is derived from Geofabrik's own index: for each DCS airport, the
smallest extract whose boundary contains it. Downloads go to a temp work
dir outside the project, are filtered once to a small per-extract taxiway
cache (<extract>.taxiways.json) and deleted immediately. --keep keeps those
caches for the next run (re-runs then need no downloads); --refresh ignores
them and fetches fresh OSM data. Without --keep the work dir is removed at
the end. The only file written to the repo is the label JSON,
which holds anchor points only (no OSM geometry, ids or tags).

Usage:
    pip install osmium requests
    python server/scripts/buildTaxiwayLabels.py                  # every theatre with airports_polygons.json
    python server/scripts/buildTaxiwayLabels.py Nevada Syria     # just these
    python server/scripts/buildTaxiwayLabels.py --keep           # keep taxiway caches for re-runs
    python server/scripts/buildTaxiwayLabels.py --keep --refresh # re-download, refresh the caches
    python server/scripts/buildTaxiwayLabels.py --work-dir D:/osm

Data (c) OpenStreetMap contributors, ODbL.
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from collections import defaultdict

import osmium
import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NAVDATA_DIR = os.path.join(SCRIPT_DIR, '..', 'navdata')
CACHE_DIR = os.path.join(NAVDATA_DIR, 'cache')
THEATRES_PATH = os.path.join(NAVDATA_DIR, 'config', 'theatres.json')
OUT_NAME = 'airports_taxiway_labels.json'

GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'

SAMPLE_STEP_M = 10        # spacing of the points tested against DCS pavement
MIN_RUN_M = 60            # continuous on-pavement length needed to earn a label
CLAIM_RADIUS_M = 20       # pavement already claimed by a longer run of another ref
ANCHOR_SPACING_M = 600    # long runs get one label per this many metres
MERGE_RADIUS_M = 150      # same-ref anchors closer than this collapse into one
AIRPORT_PAD_DEG = 0.01    # OSM ways are read if they touch this padded airport bbox
MAX_REF_LEN = 12

# OSM sometimes puts street-style names in name= (fly-in communities), so
# name= is only a fallback when it looks like a designator.
NAME_DESIGNATOR_RE = re.compile(r'^[A-Z]{1,2}\d{0,2}[A-Z]?$')
# A taxiway tagged with a runway reference (a disused runway now used for
# taxiing, e.g. "RUNWAY 09/27", "OLD RUNWAY") would read as a runway label.
RUNWAY_REF_RE = re.compile(r'\b(RUNWAY|RWY)\b')
TAXIWAY_PREFIX_RE = re.compile(r'^(TWY|TAXIWAY)\s+')
PHONETIC = {w: w[0] for w in (
    'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA',
    'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO',
    'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY', 'YANKEE', 'ZULU')}
PHONETIC.update({'ALFA': 'A', 'JULIETT': 'J', 'X-RAY': 'X'})
NUMBER_WORDS = {w: str(i) for i, w in enumerate(
    ('ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'))}
NUMBER_WORDS['NINER'] = '9'

DOWNLOAD_DELAY_S = 3
MAX_RETRIES = 4
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON_EQ = 111320.0


# --- geometry helpers ------------------------------------------------------

def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def ring_bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def polygons_of(geometry):
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    return []


def resample(coords, step_m):
    """Points every step_m metres along a [lon, lat] polyline."""
    out = []
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        kx = M_PER_DEG_LON_EQ * math.cos(math.radians(y1))
        d = math.hypot((x2 - x1) * kx, (y2 - y1) * M_PER_DEG_LAT)
        n = max(1, int(d // step_m))
        for k in range(n):
            out.append((x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n))
    out.append(tuple(coords[-1]))
    return out


# --- Geofabrik ---------------------------------------------------------------

def download(url, dest):
    if os.path.exists(dest):
        size_mb = os.path.getsize(dest) / 1024 / 1024
        print(f'  {os.path.basename(dest)}: using kept copy ({size_mb:.1f} MB)')
        return
    for attempt in range(1, MAX_RETRIES + 1):
        print(f'  {os.path.basename(dest)}: downloading...', end='', flush=True)
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                if r.status_code in (429, 503):
                    wait = int(r.headers.get('Retry-After', 30 * attempt))
                    print(f' rate-limited (HTTP {r.status_code}), waiting {wait}s')
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                tmp = dest + '.part'
                with open(tmp, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        f.write(chunk)
                # Geofabrik serves its not-found page with HTTP 200, so check
                # the payload isn't HTML before trusting it.
                with open(tmp, 'rb') as f:
                    first = f.read(16)
                if first.lstrip()[:1] == b'<':
                    os.remove(tmp)
                    raise RuntimeError(f'got HTML instead of data for {url}')
                os.replace(tmp, dest)
            size_mb = os.path.getsize(dest) / 1024 / 1024
            print(f' done ({size_mb:.1f} MB)')
            time.sleep(DOWNLOAD_DELAY_S)
            return
        except requests.exceptions.RequestException as e:
            print(f' error ({e}), retrying in {10 * attempt}s')
            time.sleep(10 * attempt)
    raise RuntimeError(f'{os.path.basename(dest)}: failed after {MAX_RETRIES} attempts')


def load_extract_index(work_dir, refresh):
    path = os.path.join(work_dir, 'geofabrik-index-v1.json')
    if refresh and os.path.exists(path):
        os.remove(path)
    download(GEOFABRIK_INDEX_URL, path)
    with open(path, encoding='utf8') as f:
        index = json.load(f)
    extracts = []
    for feat in index['features']:
        props = feat.get('properties', {})
        url = props.get('urls', {}).get('pbf')
        if not url or not feat.get('geometry'):
            continue
        polys = [[r for r in poly if len(r) >= 3] for poly in polygons_of(feat['geometry'])]
        polys = [p for p in polys if p]
        rings = [(ring, ring_bbox(ring)) for poly in polys for ring in poly]
        if not rings:
            continue
        area = 0.0
        for poly in polys:
            outer = poly[0]
            lat0 = math.radians(sum(p[1] for p in outer) / len(outer))
            a = 0.0
            for (x1, y1), (x2, y2) in zip(outer, outer[1:] + outer[:1]):
                a += x1 * y2 - x2 * y1
            area += abs(a) / 2 * math.cos(lat0)
        extracts.append({'id': props['id'], 'url': url, 'rings': rings, 'area': area})
    return extracts


def extract_containing(extracts, lon, lat):
    """Smallest Geofabrik extract whose boundary contains the point."""
    best = None
    for ex in extracts:
        hits = 0
        for ring, (a, b, c, d) in ex['rings']:
            if a <= lon <= c and b <= lat <= d and point_in_ring(lon, lat, ring):
                hits += 1
        if hits % 2 == 1 and (best is None or ex['area'] < best['area']):
            best = ex
    return best


# --- DCS airports --------------------------------------------------------------

def load_airports(folder):
    """{stem: {'rings', 'runways', 'bbox'}} of DCS taxiway pavement, with the
    airport's runway rings alongside. DCS taxiway outlines carry on under the
    runways they cross, so runway pavement has to be excluded explicitly or a
    connector's label can land on the runway."""
    path = os.path.join(CACHE_DIR, folder, 'airports_polygons.json')
    with open(path, encoding='utf8') as f:
        features = json.load(f)['features']
    airports = defaultdict(lambda: {'rings': [], 'runways': []})
    for feat in features:
        props = feat['properties']
        key = {'taxiway': 'rings', 'runway': 'runways'}.get(props.get('type'))
        if not key:
            continue
        for poly in polygons_of(feat['geometry']):
            ring = poly[0]
            airports[props['airport']][key].append((ring, ring_bbox(ring)))
    out = {}
    for stem, ap in airports.items():
        if not ap['rings']:
            continue
        bbs = [bb for _, bb in ap['rings']]
        ap['bbox'] = (min(b[0] for b in bbs), min(b[1] for b in bbs),
                      max(b[2] for b in bbs), max(b[3] for b in bbs))
        out[stem] = ap
    return out


# --- OSM read ------------------------------------------------------------------

def normalize_designator(text):
    """Scope-style designator: drops a TWY/TAXIWAY prefix ("TWY A" -> "A")
    and turns a leading spelled-out phonetic letter plus number words into
    the short form ("ALPHA ONE" -> "A1", "BRAVO EAST" -> "B EAST")."""
    words = TAXIWAY_PREFIX_RE.sub('', text.upper().replace(';', '/')).split()
    if words and words[0] in PHONETIC:
        head = PHONETIC[words[0]]
        rest = words[1:]
        while rest and (rest[0] in NUMBER_WORDS or rest[0].isdigit()):
            word = rest.pop(0)
            head += NUMBER_WORDS.get(word, word)
        words = [head] + rest
    return ' '.join(words)


def label_text(tags):
    """Display label from a way's ref/name (dict-like), or None."""
    ref = (tags.get('ref') or '').strip()
    if ref:
        ref = normalize_designator(ref)
        return ref if ref and len(ref) <= MAX_REF_LEN and not RUNWAY_REF_RE.search(ref) else None
    name = normalize_designator((tags.get('name') or '').strip())
    return name if NAME_DESIGNATOR_RE.match(name) else None


def read_taxiways(pbf_path):
    """Every taxiway way in one extract that carries a ref or name, as
    [{'id', 'ref', 'name', 'coords': [[lon, lat], ...]}]. Raw tags are kept
    (not the derived label) so a change to the label rule needs no
    re-download."""
    ways = []
    fp = (osmium.FileProcessor(pbf_path)
          .with_locations()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
          .with_filter(osmium.filter.TagFilter(('aeroway', 'taxiway'), ('aeroway', 'taxilane'))))
    for w in fp:
        ref, name = w.tags.get('ref'), w.tags.get('name')
        if not ref and not name:
            continue
        try:
            coords = [[round(n.lon, 7), round(n.lat, 7)] for n in w.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(coords) >= 2:
            ways.append({'id': w.id, 'ref': ref, 'name': name, 'coords': coords})
    return ways


def extract_taxiways(ex_id, url, work_dir, refresh):
    """Cached taxiways of one extract. The .pbf is only ever on disk long
    enough to be read: it's filtered to <id>.taxiways.json (a few hundred
    KB at most) and deleted straight away."""
    base = ex_id.replace('/', '_')
    cache_path = os.path.join(work_dir, f'{base}.taxiways.json')
    if os.path.exists(cache_path) and not refresh:
        with open(cache_path, encoding='utf8') as f:
            ways = json.load(f)
        print(f'  {ex_id}: {len(ways)} taxiways from cache')
        return ways
    pbf = os.path.join(work_dir, f'{base}-latest.osm.pbf')
    if refresh and os.path.exists(pbf):
        os.remove(pbf)
    download(url, pbf)
    print(f'  {ex_id}: reading taxiways...', end='', flush=True)
    ways = read_taxiways(pbf)
    print(f' {len(ways)}')
    with open(cache_path, 'w', encoding='utf8') as f:
        json.dump(ways, f, separators=(',', ':'), ensure_ascii=False)
    os.remove(pbf)
    return ways


# --- matching --------------------------------------------------------------------

def hit_airport(x, y, airports):
    for stem, ap in airports.items():
        a, b, c, d = ap['bbox']
        if not (a <= x <= c and b <= y <= d):
            continue
        for ring, (ra, rb, rc, rd) in ap['rings']:
            if ra <= x <= rc and rb <= y <= rd and point_in_ring(x, y, ring):
                on_runway = any(qa <= x <= qc and qb <= y <= qd and point_in_ring(x, y, rw)
                                for rw, (qa, qb, qc, qd) in ap['runways'])
                return None if on_runway else stem
    return None


def on_pavement_runs(label, coords, airports):
    """Split a way into runs of consecutive samples on one airport's pavement."""
    runs = []
    cur, cur_stem = [], None
    for x, y in resample(coords, SAMPLE_STEP_M):
        stem = hit_airport(x, y, airports)
        if stem is not None and stem == cur_stem:
            cur.append((x, y))
            continue
        if cur:
            runs.append((cur_stem, label, cur))
        cur, cur_stem = ([(x, y)], stem) if stem is not None else ([], None)
    if cur:
        runs.append((cur_stem, label, cur))
    return [r for r in runs if len(r[2]) * SAMPLE_STEP_M >= MIN_RUN_M]


class ClaimGrid:
    """Pavement already labelled, per airport, as a coarse metre grid."""

    def __init__(self, lat0):
        self.kx = M_PER_DEG_LON_EQ * math.cos(math.radians(lat0))
        self.cells = defaultdict(set)

    def _cell(self, x, y):
        return (int(x * self.kx // CLAIM_RADIUS_M), int(y * M_PER_DEG_LAT // CLAIM_RADIUS_M))

    def conflicts(self, x, y, label):
        cx, cy = self._cell(x, y)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other in self.cells.get((cx + dx, cy + dy), ()):
                    if other != label:
                        return True
        return False

    def claim(self, pts, label):
        for x, y in pts:
            self.cells[self._cell(x, y)].add(label)


def build_labels(airports, ways):
    runs = []
    for label, coords in ways.values():
        runs.extend(on_pavement_runs(label, coords, airports))

    # Longer runs claim pavement first; a shorter run of a different ref
    # loses whatever stretch it shares (e.g. a connector whose OSM way
    # rides along the parallel taxiway for a junction's length).
    runs.sort(key=lambda r: -len(r[2]))
    grids = {stem: ClaimGrid((ap['bbox'][1] + ap['bbox'][3]) / 2) for stem, ap in airports.items()}
    kept = []
    for stem, label, pts in runs:
        grid = grids[stem]
        piece = []
        pieces = []
        for x, y in pts:
            if grid.conflicts(x, y, label):
                if piece:
                    pieces.append(piece)
                piece = []
            else:
                piece.append((x, y))
        if piece:
            pieces.append(piece)
        for p in pieces:
            if len(p) * SAMPLE_STEP_M >= MIN_RUN_M:
                grid.claim(p, label)
                kept.append((stem, label, p))

    anchors = []
    for stem, label, pts in kept:
        run_m = len(pts) * SAMPLE_STEP_M
        n = max(1, round(run_m / ANCHOR_SPACING_M))
        for i in range(n):
            x, y = pts[min(len(pts) - 1, int((i + 0.5) * len(pts) / n))]
            anchors.append({'airport': stem, 'ref': label, 'lat': round(y, 6), 'lon': round(x, 6), 'runM': run_m})

    # Collapse same-ref anchors that landed close together (OSM often splits
    # one taxiway into several ways), keeping the one from the longer run.
    anchors.sort(key=lambda a: -a['runM'])
    merged = []
    for a in anchors:
        kx = M_PER_DEG_LON_EQ * math.cos(math.radians(a['lat']))
        close = any(
            m['airport'] == a['airport'] and m['ref'] == a['ref'] and
            math.hypot((m['lon'] - a['lon']) * kx, (m['lat'] - a['lat']) * M_PER_DEG_LAT) < MERGE_RADIUS_M
            for m in merged)
        if not close:
            merged.append(a)
    merged.sort(key=lambda a: (a['airport'], a['ref'], a['lat'], a['lon']))
    return merged, runs


# --- main ------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='Build taxiway label anchors from OSM.')
    ap.add_argument('theatres', nargs='*', help='theatre keys from theatres.json (default: all with airports_polygons.json)')
    ap.add_argument('--keep', action='store_true', help='keep the filtered per-extract taxiway caches in the work dir for the next run')
    ap.add_argument('--refresh', action='store_true', help='ignore cached taxiways and download fresh OSM data')
    ap.add_argument('--work-dir', default=os.path.join(tempfile.gettempdir(), 'tracs-osm'),
                    help='where extracts are downloaded (default: OS temp dir)')
    args = ap.parse_args()

    with open(THEATRES_PATH, encoding='utf8') as f:
        theatres = json.load(f)
    wanted = args.theatres or [t for t, c in theatres.items()
                               if os.path.exists(os.path.join(CACHE_DIR, c['folder'], 'airports_polygons.json'))]
    unknown = [t for t in wanted if t not in theatres]
    if unknown:
        print(f'Unknown theatre(s): {", ".join(unknown)}. Known: {", ".join(theatres)}')
        sys.exit(1)

    work_dir = os.path.abspath(args.work_dir)
    project_root = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
    if os.path.commonpath([work_dir, project_root]) == project_root:
        print(f'--work-dir must be outside the project ({project_root}) so raw OSM data never lands in it.')
        sys.exit(1)
    os.makedirs(work_dir, exist_ok=True)

    try:
        airports_by_theatre = {}
        for t in wanted:
            path = os.path.join(CACHE_DIR, theatres[t]['folder'], 'airports_polygons.json')
            if not os.path.exists(path):
                print(f'{t}: skipped - no airports_polygons.json')
                continue
            airports_by_theatre[t] = load_airports(theatres[t]['folder'])

        print('Geofabrik index:')
        extracts = load_extract_index(work_dir, args.refresh)

        # extract id -> {'url', 'needs': [(theatre, padded bbox)]}
        plan = {}
        for t, airports in airports_by_theatre.items():
            for stem, apt in airports.items():
                a, b, c, d = apt['bbox']
                ex = extract_containing(extracts, (a + c) / 2, (b + d) / 2)
                if ex is None:
                    print(f'  {t}/{stem}: no Geofabrik extract covers it - skipped')
                    continue
                entry = plan.setdefault(ex['id'], {'url': ex['url'], 'needs': []})
                entry['needs'].append((t, (a - AIRPORT_PAD_DEG, b - AIRPORT_PAD_DEG,
                                           c + AIRPORT_PAD_DEG, d + AIRPORT_PAD_DEG)))

        print(f'\nExtracts needed: {", ".join(sorted(plan))}\n')
        ways_by_theatre = defaultdict(dict)
        for ex_id, entry in sorted(plan.items()):
            try:
                ways = extract_taxiways(ex_id, entry['url'], work_dir, args.refresh)
            except Exception as e:
                print(f'  {ex_id}: FAILED ({e}) - skipping')
                continue
            boxes_by_theatre = defaultdict(list)
            for t, box in entry['needs']:
                boxes_by_theatre[t].append(box)
            for way in ways:
                label = label_text(way)
                if not label:
                    continue
                xs = [c[0] for c in way['coords']]
                ys = [c[1] for c in way['coords']]
                wa, wb, wc, wd = min(xs), min(ys), max(xs), max(ys)
                for t, boxes in boxes_by_theatre.items():
                    if any(wa <= c and wc >= a and wb <= d and wd >= b for a, b, c, d in boxes):
                        ways_by_theatre[t][way['id']] = (label, way['coords'])

        print()
        for t, airports in airports_by_theatre.items():
            labels, runs = build_labels(airports, ways_by_theatre.get(t, {}))
            out_path = os.path.join(CACHE_DIR, theatres[t]['folder'], OUT_NAME)
            with open(out_path, 'w', encoding='utf8') as f:
                json.dump({'attribution': ATTRIBUTION, 'labels': labels}, f, separators=(',', ':'), ensure_ascii=False)
            per_ap = defaultdict(set)
            for lab in labels:
                per_ap[lab['airport']].add(lab['ref'])
            print(f'{t}: {len(labels)} labels at {len(per_ap)}/{len(airports)} airports -> {os.path.relpath(out_path, project_root)}')
            for stem in sorted(per_ap):
                refs = sorted(per_ap[stem])
                print(f'    {stem:36} {len(refs):3}  {" ".join(refs)}')
    finally:
        if not args.keep:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
