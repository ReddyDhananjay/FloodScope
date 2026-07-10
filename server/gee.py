#!/usr/bin/env python3
"""
Google Earth Engine - Flood Detection + CSV Export + Point Frequency
Detects floods using Sentinel-1 SAR and exports point data as CSV.

Usage:
  python3 gee.py --file area.kml --start 2024-08-25 --end 2024-09-05 --key ee-key.json --export-csv true
  python3 gee.py --sample --lat 16.5 --lng 80.6 --start 2024-08-25 --end 2024-09-05 --key ee-key.json
  python3 gee.py --region-frequency --coords '[[lng,lat],...]' --start 2022-01-01 --end 2024-12-31 --key ee-key.json --num-points 25

Performance note (important):
  sample_point_frequency() used to loop over every individual Sentinel-1
  image in Python and call .getInfo() several times PER IMAGE (date,
  orbit, platform, incidence angle, band names, sampled value). For a
  multi-month/multi-year date range that is 30-500+ images, i.e. hundreds
  of sequential network round-trips to Earth Engine -- which is exactly
  what was blowing past the request timeout and showing "Query timed
  out" in the UI. It (and the new sample_region_frequency()) now build
  the whole per-image computation as a single server-side EE object
  (ImageCollection.map / Image.reduceRegions) and fetch the entire
  result with ONE .getInfo() call, then do the light bookkeeping (dB
  conversion, thresholding, event clustering) locally in Python. This
  turns O(images) round-trips into O(1), regardless of how long a date
  range is selected.
"""
import ee
import json
import csv
import argparse
import sys
import math
import statistics
import zipfile
import xml.etree.ElementTree as ET
import os
import io
from datetime import datetime, timedelta

# ----------------------------------------------------------------------
# Flood classification thresholds.
#
# A single fixed "VH < -18 dB" cutoff (the old behaviour) misses a lot of
# real floods: the right cutoff depends heavily on local land cover
# (bare soil, crops, urban surfaces all have different baseline
# backscatter), and urban flooding in particular can INCREASE radar
# backscatter (double-bounce off flooded walls/streets) rather than
# lowering it, so a pure "look for low VH" rule can miss it.
#
# IMPORTANT FIX #1: an earlier version compared each pass to the MEDIAN
# of the passes inside the very same query window. That silently breaks
# whenever the whole requested date range sits inside/around a real
# flood -- the median gets dragged down by the flood itself, so the
# "relative drop" never triggers and a real flood gets reported as dry.
#
# IMPORTANT FIX #2: a historical Dec-Mar "dry season" composite is a
# reasonable fallback but is still a coarse, generic proxy -- normal
# year-to-year soil moisture, cropping, and (for coastal Andhra
# Pradesh specifically) the Oct-Dec northeast monsoon can all shift
# what "dry" looks like, so it can under- or over-estimate the true
# baseline for one specific flood event.
#
# The most reliable, literature-standard reference for "did THIS event
# cause a real drop here" is the location's OWN backscatter immediately
# BEFORE the event -- a short pre-event window in the SAME year, right
# before the requested start date. That's what change-detection flood
# mapping (e.g. UN-SPIDER's recommended Sentinel-1 workflow) actually
# compares against, and it's what we now use as the primary baseline:
#
#   1. Immediate pre-event window (PRE_EVENT_LOOKBACK_DAYS days right
#      before the requested start date, same year) -- most directly
#      relevant to the specific flood being checked.
#   2. Historical dry-season (Jan-Apr) composite across all years --
#      used only if there's no usable pre-event coverage (e.g. the
#      query starts right at the beginning of the archive).
#   3. The window's own median VH -- last-resort fallback.
#   4. Absolute threshold only, if nothing else is available.
# ----------------------------------------------------------------------
ABS_FLOOD_THRESH_DB = -18
REL_DROP_DB = 2.5
MIN_PASSES_FOR_BASELINE = 3
PRE_EVENT_LOOKBACK_DAYS = 60
DRY_SEASON_MONTHS = [1, 2, 3, 4]  # Jan-Apr: driest window before either Indian monsoon


def dry_season_filter():
    """Earth Engine filter matching Jan-Apr acquisitions (pre-monsoon dry season)."""
    return ee.Filter.calendarRange(1, 4, 'month')


def _median_vh_db(collection, geometry):
    """
    Median VH (dB) of `collection` at `geometry`. One .getInfo() call.

    IMPORTANT: Earth Engine's COPERNICUS/S1_GRD collection already
    delivers backscatter values pre-converted to dB (Google's own
    preprocessing pipeline does that before the data reaches us) --
    the raw band value IS the dB value already. An earlier version of
    this code re-applied 10*log10(value) on top of that, and since
    real dB readings are negative, the old "value > 0" guard silently
    discarded almost every real reading, which is why flood frequency
    was showing 0 everywhere regardless of location or date range.
    """
    count = collection.size().getInfo()
    if count == 0:
        return None, 0
    composite = collection.select('VH').median()
    val = composite.reduceRegion(reducer=ee.Reducer.first(), geometry=geometry, scale=30).get('VH').getInfo()
    if val is None:
        return None, count
    return round(val, 2), count


def get_reference_baselines(geometry, start_date):
    """
    Compute both candidate independent baselines for a single point:
    the immediate pre-event window and the historical dry-season
    composite. Returns (pre_event_vh, pre_event_count, dry_season_vh,
    dry_season_count). Two .getInfo() calls total, regardless of how
    long the requested date range is.
    """
    start = datetime.strptime(start_date, '%Y-%m-%d').date()
    pre_start = (start - timedelta(days=PRE_EVENT_LOOKBACK_DAYS)).isoformat()
    pre_end = (start - timedelta(days=1)).isoformat()

    pre_event_collection = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(geometry) \
        .filterDate(pre_start, pre_end) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    pre_event_vh, pre_event_count = _median_vh_db(pre_event_collection, geometry)

    dry_collection = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(geometry) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')) \
        .filter(dry_season_filter())
    dry_season_vh, dry_season_count = _median_vh_db(dry_collection, geometry)

    return pre_event_vh, pre_event_count, dry_season_vh, dry_season_count


def pick_baseline(pre_event_vh, dry_season_vh, window_median):
    """Preference order documented above: pre-event > dry-season > window median."""
    if pre_event_vh is not None:
        return pre_event_vh, 'pre-event-reference'
    if dry_season_vh is not None:
        return dry_season_vh, 'dry-season-reference'
    if window_median is not None:
        return window_median, 'within-window-median (no independent reference available)'
    return None, 'absolute-threshold-only'


def classify_floods(vh_values, dry_baseline=None):
    """
    Given a list of VH dB values (None allowed for missing passes) and an
    already-resolved baseline (see pick_baseline), return
    (flags, baseline_used, effectively -- kept for backward compatibility
    with callers that pass a single resolved baseline value directly).
    """
    valid = [v for v in vh_values if v is not None]
    if dry_baseline is not None:
        baseline, source = dry_baseline, 'reference-baseline'
    elif len(valid) >= MIN_PASSES_FOR_BASELINE:
        baseline, source = statistics.median(valid), 'within-window-median (no reference available)'
    else:
        baseline, source = None, 'absolute-threshold-only'

    flags = []
    for v in vh_values:
        if v is None:
            flags.append(False)
            continue
        abs_flag = v < ABS_FLOOD_THRESH_DB
        rel_flag = baseline is not None and v <= (baseline - REL_DROP_DB)
        flags.append(bool(abs_flag or rel_flag))
    return flags, baseline, source


def initialize_ee(key_path):
    try:
        if os.path.exists(key_path):
            with open(key_path) as f:
                key = json.load(f)
            credentials = ee.ServiceAccountCredentials(key['client_email'], key_path)
            ee.Initialize(credentials)
            print("  [GEE] Authenticated via service account", file=sys.stderr)
            return True
    except Exception as e:
        print(f"  [GEE] Service account failed: {e}", file=sys.stderr)
    try:
        ee.Initialize()
        print("  [GEE] Authenticated via default credentials", file=sys.stderr)
        return True
    except Exception as e2:
        print(f"  [GEE] Could not initialize: {e2}", file=sys.stderr)
        sys.exit(1)


def parse_kml(file_path):
    if file_path.endswith('.kmz'):
        with zipfile.ZipFile(file_path, 'r') as z:
            kml_name = [n for n in z.namelist() if n.endswith('.kml')][0]
            kml_content = z.read(kml_name).decode('utf-8')
    else:
        with open(file_path, 'r') as f:
            kml_content = f.read()

    root = ET.fromstring(kml_content)
    coords = []
    for coord_elem in root.iter():
        if coord_elem.tag.endswith('coordinates'):
            text = (coord_elem.text or '').strip()
            for pair in text.split():
                parts = pair.split(',')
                if len(parts) >= 2:
                    coords.append([float(parts[0]), float(parts[1])])

    if not coords:
        print("  [GEE] ERROR: No coordinates found", file=sys.stderr)
        sys.exit(1)

    lngs = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return {
        'bounds': [min(lngs), min(lats), max(lngs), max(lats)],
        'coords': coords,
        'center': [sum(lats) / len(lats), sum(lngs) / len(lngs)],
    }


def detect_floods_and_export(bounds, kml_coords, start_date, end_date, export_csv=False):
    print(f"  [GEE] Analyzing: {start_date} to {end_date}", file=sys.stderr)

    if len(kml_coords) >= 3:
        aoi = ee.Geometry.Polygon([kml_coords + [kml_coords[0]]])
    else:
        aoi = ee.Geometry.Rectangle(bounds, 'EPSG:4326', False)

    s1 = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(aoi) \
        .filterDate(start_date, end_date) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))

    count = s1.size().getInfo()
    print(f"  [GEE] Sentinel-1 images: {count}", file=sys.stderr)

    if count == 0:
        s1 = ee.ImageCollection('COPERNICUS/S1_GRD') \
            .filterBounds(aoi).filterDate(start_date, end_date) \
            .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        count = s1.size().getInfo()

    if count == 0:
        return {'error': f'No satellite imagery for {start_date} to {end_date}. Try different dates.', 'imageCount': 0}

    post = s1.select('VH').mosaic().focal_mean(50, 'circle', 'meters', 5)

    start_dt = datetime.strptime(start_date, '%Y-%m-%d')
    end_dt = datetime.strptime(end_date, '%Y-%m-%d')
    ref_start = (start_dt - timedelta(days=365)).strftime('%Y-%m-%d')
    ref_end = (end_dt - timedelta(days=365)).strftime('%Y-%m-%d')

    ref = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(aoi).filterDate(ref_start, ref_end) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    ref_count = ref.size().getInfo()
    print(f"  [GEE] Reference images: {ref_count}", file=sys.stderr)

    THRESH = -18
    post_water = post.lt(THRESH)

    if ref_count > 0:
        ref_img = ref.select('VH').mosaic().focal_mean(50, 'circle', 'meters', 5)
        ref_water = ref_img.lt(THRESH)
        flood = post_water.And(ref_water.Not()).rename('flood')
    else:
        flood = post_water.rename('flood')

    flood_vis = flood.visualize(min=0, max=1, palette=['ffffff00', '0066ff'], opacity=0.6)
    tile_url = None
    try:
        map_id = flood_vis.getMapId({})
        tile_url = map_id['tile_fetcher'].url_format
        print(f"  [GEE] Tile layer generated", file=sys.stderr)
    except Exception as e:
        print(f"  [GEE] Tile failed: {e}", file=sys.stderr)

    area_km2 = 0
    try:
        flood_area = flood.multiply(ee.Image.pixelArea()).reduceRegion(
            reducer=ee.Reducer.sum(), geometry=aoi, scale=30, maxPixels=1e9).getInfo()
        area_m2 = flood_area.get('flood', 0) if flood_area else 0
        area_km2 = round(area_m2 / 1e6, 2)
        print(f"  [GEE] Flooded area: {area_km2} km²", file=sys.stderr)
    except Exception as e:
        print(f"  [GEE] Area calc failed: {e}", file=sys.stderr)

    csv_data = ''
    point_count = 0
    if export_csv:
        try:
            samples = flood.stratifiedSample(
                numPoints=500, classBand='flood', region=aoi, scale=100, seed=42, geometries=True).getInfo()
            if samples and 'features' in samples:
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(['fid', 'latitude', 'longitude', 'is_flooded', 'date_analyzed'])
                for i, f in enumerate(samples['features']):
                    coord = f['geometry']['coordinates']
                    props = f.get('properties', {})
                    is_flood = props.get('flood', 0)
                    writer.writerow([i + 1, round(coord[1], 6), round(coord[0], 6), is_flood, start_date])
                    point_count += 1
                csv_data = output.getvalue()
                print(f"  [GEE] CSV export: {point_count} points", file=sys.stderr)
        except Exception as e:
            print(f"  [GEE] CSV export failed: {e}", file=sys.stderr)

    result = {
        'tileUrl': tile_url,
        'floodedAreaKm2': area_km2,
        'imageCount': count,
        'refImageCount': ref_count,
        'dateRange': f'{start_date} to {end_date}',
        'csvData': csv_data,
        'csvPointCount': point_count,
        'bounds': bounds,
        'center': [bounds[1] + (bounds[3] - bounds[1]) / 2, bounds[0] + (bounds[2] - bounds[0]) / 2],
    }
    return result


def merge_date_ranges(ranges, gap_days=15):
    """
    Merge a list of {'start','end'} date-string ranges (e.g. flood events
    from many different sample points) into a single boundary-wide
    timeline of distinct flood periods, joining ranges that are within
    `gap_days` of each other.
    """
    if not ranges:
        return []
    parsed = [
        {'start': r['start'], 'end': r['end'],
         '_s': datetime.strptime(r['start'], '%Y-%m-%d').date(),
         '_e': datetime.strptime(r['end'], '%Y-%m-%d').date()}
        for r in ranges
    ]
    parsed.sort(key=lambda r: r['_s'])
    merged = [parsed[0]]
    for r in parsed[1:]:
        last = merged[-1]
        if (r['_s'] - last['_e']).days <= gap_days:
            if r['_e'] > last['_e']:
                last['end'] = r['end']
                last['_e'] = r['_e']
        else:
            merged.append(r)
    return [{'start': m['start'], 'end': m['end']} for m in merged]


def cluster_flood_events(flagged_dates, gap_days=15):
    """
    Group a list of 'YYYY-MM-DD' date strings (dates of flood-flagged
    satellite passes) into distinct flood EVENTS. Sentinel-1 revisits the
    same spot roughly every 6-12 days, so one real flood can show up as
    several consecutive flagged passes. We start a new event whenever
    there's a gap of more than `gap_days` between flagged passes. This
    gives an actual count of "how many times it flooded in this period"
    instead of a raw satellite-pass count.
    """
    events = []
    for date_str in sorted(set(flagged_dates)):
        d = datetime.strptime(date_str, '%Y-%m-%d').date()
        if events and (d - events[-1]['_endDate']).days <= gap_days:
            events[-1]['end'] = date_str
            events[-1]['_endDate'] = d
            events[-1]['passCount'] += 1
        else:
            events.append({'start': date_str, 'end': date_str, '_endDate': d, 'passCount': 1})
    for e in events:
        del e['_endDate']
    return events


# ----------------------------------------------------------------------
# RAINFALL CORROBORATION (independent of Sentinel-1 SAR revisit gaps)
#
# Sentinel-1 only sees a flood if a satellite pass happens to fly over
# during or right after it -- with a 6-12+ day revisit cycle (worse
# since the Sentinel-1B failure in Dec 2021 thinned the constellation),
# it's entirely possible for a real flood to peak and recede between two
# passes with nothing radar ever "sees". Rainfall, on the other hand, is
# measured by satellite globally EVERY DAY, so it's a second, independent
# way to tell whether a flood-triggering event happened even when SAR
# missed it directly.
#
# We use CHIRPS Daily precipitation (UCSB/NOAA, ~5km resolution, global,
# 1981-present) and flag days at/above India Meteorological Department's
# "Heavy Rainfall" threshold (64.5 mm/day). Consecutive heavy-rain days
# are clustered into rainfall EVENTS the same way SAR passes are, and
# each rainfall event is cross-referenced against the nearest Sentinel-1
# pass so we can tell the user plainly: "SAR confirmed this" vs "heavy
# rain happened but no satellite radar pass was close enough to confirm
# standing floodwater directly."
# ----------------------------------------------------------------------
HEAVY_RAIN_MM = 64.5  # IMD "Heavy rainfall" category (mm/day)
RAIN_EVENT_GAP_DAYS = 3
SAR_CONFIRMATION_WINDOW_DAYS = 10


def get_rainfall_series(geometry, start_date, end_date):
    """
    Daily rainfall (mm) at `geometry` for start_date..end_date using
    CHIRPS Daily precipitation. Measured every day regardless of SAR
    coverage, so it can corroborate a flood on days Sentinel-1 never
    imaged. ONE .getInfo() call regardless of how many days requested.
    """
    end_inclusive = (datetime.strptime(end_date, '%Y-%m-%d').date() + timedelta(days=1)).isoformat()
    chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
        .filterBounds(geometry) \
        .filterDate(start_date, end_inclusive)

    count = chirps.size().getInfo()
    if count == 0:
        return {'dailyTotals': [], 'heavyRainDays': 0, 'rainfallEvents': [], 'maxDailyMm': 0,
                'dataset': 'CHIRPS Daily Precipitation (UCSB/NOAA)', 'available': False}

    def extract(img):
        img = ee.Image(img)
        val = img.reduceRegion(reducer=ee.Reducer.first(), geometry=geometry, scale=5000).get('precipitation')
        return ee.Feature(None, {'date': img.date().format('YYYY-MM-dd'), 'mm': val})

    fc = ee.FeatureCollection(chirps.map(extract)).getInfo()
    days = []
    for f in fc.get('features', []):
        p = f.get('properties', {})
        mm = p.get('mm')
        if mm is not None:
            days.append({'date': p.get('date'), 'mm': round(mm, 1)})
    days.sort(key=lambda d: d['date'])

    heavy_dates = [d['date'] for d in days if d['mm'] >= HEAVY_RAIN_MM]
    events = cluster_flood_events(heavy_dates, gap_days=RAIN_EVENT_GAP_DAYS)
    max_mm = max((d['mm'] for d in days), default=0)

    return {
        'dailyTotals': days,
        'heavyRainDays': len(heavy_dates),
        'rainfallEvents': events,
        'maxDailyMm': max_mm,
        'dataset': 'CHIRPS Daily Precipitation (UCSB/NOAA, ~5km resolution)',
        'available': True,
    }


def cross_reference_rainfall(rainfall_events, sar_pass_dates):
    """
    For each heavy-rainfall event, check whether a Sentinel-1 pass
    happened within SAR_CONFIRMATION_WINDOW_DAYS afterward (enough time
    to still see standing floodwater). Tells us whether a flood is
    "SAR-confirmed" or merely "rainfall suggests it, but SAR never
    imaged this spot close enough to that date to confirm directly."
    """
    parsed_pass_dates = []
    for d in sar_pass_dates:
        if not d:
            continue
        try:
            parsed_pass_dates.append(datetime.strptime(d, '%Y-%m-%d').date())
        except ValueError:
            continue

    results = []
    for ev in rainfall_events:
        ev_end = datetime.strptime(ev['end'], '%Y-%m-%d').date()
        nearest_gap = None
        for pd in parsed_pass_dates:
            gap = (pd - ev_end).days
            if 0 <= gap <= SAR_CONFIRMATION_WINDOW_DAYS:
                if nearest_gap is None or gap < nearest_gap:
                    nearest_gap = gap
        results.append({
            'start': ev['start'],
            'end': ev['end'],
            'sarConfirmedNearby': nearest_gap is not None,
            'daysToNearestSarPass': nearest_gap,
        })
    return results


# ----------------------------------------------------------------------
# HISTORICAL FLOOD RECORD CROSS-CHECK (Global Flood Database)
#
# This is a third, independent source -- not derived from our own SAR or
# rainfall math at all. The Global Flood Database (Tellman et al., Nature
# 2021) is a peer-reviewed catalog of real, individually documented flood
# events, each one cross-referenced against the Dartmouth Flood
# Observatory's records -- the same kind of government/news reporting
# that would show up if you searched the event on Google. If a query
# overlaps a cataloged event here, that's genuine third-party
# confirmation, not just our own model agreeing with itself.
#
# Coverage limit (important, and worth being upfront about): this
# dataset only covers 2000-2018. For anything after 2018 it simply has
# no opinion either way -- it's not evidence of "no flood", just outside
# its range. SAR + rainfall remain the primary signals for recent years.
# ----------------------------------------------------------------------
def get_historical_flood_record(geometry, start_date, end_date):
    try:
        gfd = ee.ImageCollection('GLOBAL_FLOOD_DB/MODIS_EVENTS/V1') \
            .filterBounds(geometry) \
            .filterDate(start_date, end_date)
        count = gfd.size().getInfo()
    except Exception as e:
        return {'available': False, 'matched': False, 'events': [], 'note': str(e)}

    if count == 0:
        return {'available': True, 'matched': False, 'events': []}

    def extract(img):
        img = ee.Image(img)
        began = ee.Date(img.get('system:time_start')).format('YYYY-MM-dd')
        ended_raw = img.get('system:time_end')
        ended = ee.Algorithms.If(ended_raw, ee.Date(ended_raw).format('YYYY-MM-dd'), began)
        return ee.Feature(None, {
            'id': img.get('id'),
            'began': began,
            'ended': ended,
            'countries': img.get('countries'),
            'severity': img.get('dfo_severity'),
            'cause': img.get('dfo_main_cause'),
        })

    try:
        fc = ee.FeatureCollection(gfd.toList(count).map(extract)).getInfo()
    except Exception as e:
        return {'available': False, 'matched': False, 'events': [], 'note': str(e)}

    events = []
    for f in fc.get('features', []):
        p = f.get('properties', {})
        events.append({
            'id': p.get('id'),
            'began': p.get('began'),
            'ended': p.get('ended'),
            'countries': p.get('countries'),
            'severity': p.get('severity'),
            'cause': p.get('cause'),
        })
    return {'available': True, 'matched': len(events) > 0, 'events': events}


def sample_point_frequency(lat, lng, start_date, end_date, key_path):
    """
    Query REAL flood FREQUENCY at a single point.

    Returns ALL available satellite data:
    - VH polarization backscatter (dB)
    - VV polarization backscatter (dB)
    - Orbit direction (ascending/descending)
    - Satellite platform (S1A/S1B)
    - Incidence angle
    - Flood classification per pass
    - Total frequency count

    This is REAL satellite data - NOT AI generated.

    Performance: every per-image value (date, orbit, platform, incidence
    angle, VH, VV) is computed server-side via ImageCollection.map() and
    fetched in a SINGLE .getInfo() call, instead of looping through each
    image in Python and calling .getInfo() 5-6 times per image (which is
    what caused "Query timed out" for anything beyond a couple months).
    """
    initialize_ee(key_path)

    point = ee.Geometry.Point([lng, lat])

    s1 = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(point) \
        .filterDate(start_date, end_date) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))

    total_images = s1.size().getInfo()
    print(f"  [GEE] Found {total_images} satellite passes at this point", file=sys.stderr)

    if total_images == 0:
        rainfall = get_rainfall_series(point, start_date, end_date)
        rainfall['crossReference'] = [
            {**r, 'sarConfirmedNearby': False, 'daysToNearestSarPass': None}
            for r in rainfall.get('rainfallEvents', [])
        ]
        historical_record = get_historical_flood_record(point, start_date, end_date)
        return {
            'lat': lat, 'lng': lng,
            'startDate': start_date, 'endDate': end_date,
            'totalPasses': 0,
            'floodFrequency': 0,
            'floodEventCount': 0,
            'floodEvents': [],
            'floodPercentage': 0,
            'isFlooded': False,
            'status': 'No satellite radar imagery for this date range at this location.',
            'passes': [],
            'rainfall': rainfall,
            'historicalRecord': historical_record,
            'likelyUncapturedFlood': rainfall.get('heavyRainDays', 0) > 0 or historical_record.get('matched', False),
            'dataset': {}
        }

    def extract(img):
        img = ee.Image(img)
        band_names = img.bandNames()
        has_vv = band_names.contains('VV')
        img2 = ee.Image(ee.Algorithms.If(
            has_vv,
            img.select(['VH', 'VV']),
            img.select(['VH']).addBands(
                ee.Image.constant(0).rename('VV').updateMask(ee.Image.constant(0))
            )
        ))
        sample = img2.reduceRegion(reducer=ee.Reducer.first(), geometry=point, scale=30)
        return ee.Feature(None, {
            'date': img.date().format('YYYY-MM-dd'),
            'orbit': img.get('orbitProperties_pass'),
            'platform': img.get('platform_number'),
            'incidenceAngle': img.get('incidenceAngle'),
            'vh': sample.get('VH'),
            'vv': sample.get('VV'),
        })

    features = ee.FeatureCollection(s1.map(extract)).getInfo()  # ONE network round-trip

    passes_data = []
    all_vh_db = []
    all_vv_db = []

    for f in features.get('features', []):
        p = f.get('properties', {})
        date_info = p.get('date')
        vh_raw = p.get('vh')
        vv_raw = p.get('vv')

        # COPERNICUS/S1_GRD band values are already in dB -- use directly,
        # don't re-apply log10 (see _median_vh_db docstring for why the
        # old version of this line silently broke detection everywhere).
        vh_db = round(vh_raw, 2) if vh_raw is not None else None
        vv_db = round(vv_raw, 2) if vv_raw is not None else None
        if vh_db is not None:
            all_vh_db.append(vh_db)
        if vv_db is not None:
            all_vv_db.append(vv_db)

        vh_vv_ratio = round(vh_db - vv_db, 2) if (vh_db is not None and vv_db is not None) else None
        incidence_angle = p.get('incidenceAngle')

        passes_data.append({
            'date': date_info,
            'vhDb': vh_db,
            'vvDb': vv_db,
            'vhVvRatio': vh_vv_ratio,
            'orbit': p.get('orbit'),
            'platform': p.get('platform') or 'S1A/S1B',
            'incidenceAngle': round(incidence_angle, 2) if incidence_angle is not None else None,
            'vhRaw': round(vh_raw, 6) if vh_raw is not None else None,
            'vvRaw': round(vv_raw, 6) if vv_raw is not None else None,
        })

    passes_data.sort(key=lambda p: p['date'] or '')

    # Independent reference baseline for this exact point -- NOT derived
    # from the passes inside the query window (so a flood that spans the
    # whole requested range still gets caught). Prefers the immediate
    # pre-event window over the historical dry-season composite (see the
    # big comment above these functions for why).
    window_median = statistics.median([p['vhDb'] for p in passes_data if p['vhDb'] is not None]) \
        if len([p for p in passes_data if p['vhDb'] is not None]) >= MIN_PASSES_FOR_BASELINE else None
    pre_event_vh, pre_event_count, dry_season_vh, dry_season_count = get_reference_baselines(point, start_date)
    baseline_vh, baseline_source = pick_baseline(pre_event_vh, dry_season_vh, window_median)
    print(f"  [GEE] Baseline: {baseline_vh}dB via {baseline_source} (pre-event: {pre_event_vh}dB/{pre_event_count} passes, dry-season: {dry_season_vh}dB/{dry_season_count} passes)", file=sys.stderr)

    flags, _, _ = classify_floods([p['vhDb'] for p in passes_data], dry_baseline=baseline_vh)
    flood_count = 0
    for p, flagged in zip(passes_data, flags):
        p['isFlooded'] = flagged
        p['baselineVhDb'] = baseline_vh
        if flagged:
            flood_count += 1

    valid_passes = len([p for p in passes_data if p['vhDb'] is not None])
    flood_percentage = round((flood_count / valid_passes * 100), 1) if valid_passes > 0 else 0

    flood_events = cluster_flood_events(
        [p['date'] for p in passes_data if p['isFlooded'] and p['date']]
    )
    flood_event_count = len(flood_events)

    avg_vh = round(sum(all_vh_db) / len(all_vh_db), 2) if all_vh_db else None
    min_vh = round(min(all_vh_db), 2) if all_vh_db else None
    max_vh = round(max(all_vh_db), 2) if all_vh_db else None
    avg_vv = round(sum(all_vv_db) / len(all_vv_db), 2) if all_vv_db else None

    asc_count = len([p for p in passes_data if p.get('orbit') == 'ASCENDING'])
    desc_count = len([p for p in passes_data if p.get('orbit') == 'DESCENDING'])

    # Independent rainfall corroboration -- CHIRPS measures rain every
    # day everywhere, so it can catch a flood-triggering event even on
    # exact dates Sentinel-1 never had a pass close enough to see.
    rainfall = get_rainfall_series(point, start_date, end_date)
    rainfall['crossReference'] = cross_reference_rainfall(
        rainfall.get('rainfallEvents', []),
        [p['date'] for p in passes_data if p.get('date')]
    )
    unconfirmed_rain_events = [r for r in rainfall['crossReference'] if not r['sarConfirmedNearby']]
    likely_uncaptured_flood = flood_count == 0 and len(unconfirmed_rain_events) > 0

    # Third, fully independent source: real documented flood events
    # (Global Flood Database), not derived from our own SAR/rainfall math.
    historical_record = get_historical_flood_record(point, start_date, end_date)

    result = {
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'startDate': start_date,
        'endDate': end_date,
        'totalPasses': total_images,
        'validPasses': valid_passes,
        'floodFrequency': flood_count,
        'floodEventCount': flood_event_count,
        'floodEvents': flood_events,
        'floodPercentage': flood_percentage,
        'isFlooded': flood_count > 0,
        'status': 'flooded' if flood_count > 0 else 'dry',
        'passes': passes_data,
        'rainfall': rainfall,
        'historicalRecord': historical_record,
        'likelyUncapturedFlood': likely_uncaptured_flood,
        # Summary statistics (REAL measured values)
        'dataset': {
            'satellite': 'Sentinel-1 (ESA Copernicus)',
            'sensor': 'C-band SAR (Synthetic Aperture Radar)',
            'resolution': '10m (IW mode)',
            'wavelength': '5.405 GHz (C-band, ~5.6cm)',
            'floodThreshold': f'{ABS_FLOOD_THRESH_DB} dB absolute, or {REL_DROP_DB} dB below this point\'s reference baseline',
            'baselineVhDb': baseline_vh,
            'baselineSource': baseline_source,
            'preEventPassCount': pre_event_count,
            'drySeasonPassCount': dry_season_count,
            'avgVhDb': avg_vh,
            'minVhDb': min_vh,
            'maxVhDb': max_vh,
            'avgVvDb': avg_vv,
            'ascendingPasses': asc_count,
            'descendingPasses': desc_count,
        },
        'dataSource': 'Real Sentinel-1 SAR + CHIRPS rainfall satellite measurements — NOT AI generated',
    }

    print(f"  [GEE] FLOOD EVENTS: {flood_event_count} distinct event(s) from {flood_count}/{valid_passes} flagged passes ({flood_percentage}%)", file=sys.stderr)
    print(f"  [GEE] Avg VH={avg_vh}dB, baseline={baseline_vh}dB, Asc={asc_count}, Desc={desc_count}", file=sys.stderr)
    print(f"  [GEE] Rainfall: {rainfall.get('heavyRainDays',0)} heavy-rain day(s), {len(unconfirmed_rain_events)} not confirmed by a nearby SAR pass", file=sys.stderr)
    return result


def sample_region_frequency(coords, start_date, end_date, key_path, num_points=25):
    """
    Scan a whole boundary (polygon) for RECURRING flood points over a
    (potentially multi-year) date range.

    For each of `num_points` sample locations spread across the polygon,
    computes the number of distinct flood EVENTS detected there in the
    date range, using the same Sentinel-1 VH-backscatter threshold logic
    as sample_point_frequency().

    Performance: rather than looping per-point-per-image in Python (which
    would be numPoints x numImages sequential .getInfo() calls -- utterly
    unworkable for a multi-year scan), every image is sampled at ALL
    points at once server-side with Image.reduceRegions(), and the whole
    per-image-per-point table is fetched with ONE .getInfo() call at the
    end. Grouping into per-point pass lists and clustering into events
    happens locally in Python afterwards.
    """
    initialize_ee(key_path)

    if len(coords) < 3:
        return {'error': 'Boundary needs at least 3 points'}

    aoi = ee.Geometry.Polygon([coords + [coords[0]]])

    num_points = max(5, min(int(num_points), 80))
    points_fc = ee.FeatureCollection.randomPoints(region=aoi, points=num_points, seed=42)
    points_fc = points_fc.map(lambda f: f.set('pid', f.get('system:index')))

    s1 = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(aoi) \
        .filterDate(start_date, end_date) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))

    total_images = s1.size().getInfo()
    print(f"  [GEE] Region scan: {total_images} satellite passes over {num_points} sample points", file=sys.stderr)

    if total_images == 0:
        rainfall = get_rainfall_series(aoi.centroid(1), start_date, end_date)
        rainfall['crossReference'] = [
            {**r, 'sarConfirmedNearby': False, 'daysToNearestSarPass': None}
            for r in rainfall.get('rainfallEvents', [])
        ]
        historical_record = get_historical_flood_record(aoi, start_date, end_date)
        return {
            'startDate': start_date, 'endDate': end_date,
            'totalImages': 0, 'numPoints': num_points,
            'points': [], 'floodedPointCount': 0, 'maxEventCount': 0,
            'floodOccurred': False, 'boundaryFloodPeriods': [],
            'rainfall': rainfall,
            'historicalRecord': historical_record,
            'likelyUncapturedFlood': rainfall.get('heavyRainDays', 0) > 0 or historical_record.get('matched', False),
            'status': 'No satellite radar imagery for this date range over this boundary.',
        }

    # Independent reference baseline PER SAMPLE POINT -- not derived from
    # the passes inside the query window, so a flood that spans the whole
    # requested range (or the whole boundary) still gets caught. Prefers
    # the immediate pre-event window (same year, right before start_date)
    # over the historical dry-season composite. Two extra reduceRegions
    # calls for the whole boundary, not per point/image.
    start_d = datetime.strptime(start_date, '%Y-%m-%d').date()
    pre_start = (start_d - timedelta(days=PRE_EVENT_LOOKBACK_DAYS)).isoformat()
    pre_end = (start_d - timedelta(days=1)).isoformat()

    pre_event_composite = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(aoi) \
        .filterDate(pre_start, pre_end) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')) \
        .select('VH').median()
    pre_event_samples = pre_event_composite.reduceRegions(collection=points_fc, reducer=ee.Reducer.first(), scale=30).getInfo()
    pre_event_by_pid = {}
    for f in pre_event_samples.get('features', []):
        props = f.get('properties', {})
        pid = props.get('pid')
        vh_raw = props.get('VH')  # already dB (see _median_vh_db docstring)
        if pid is not None and vh_raw is not None:
            pre_event_by_pid[pid] = round(vh_raw, 2)

    dry_composite = ee.ImageCollection('COPERNICUS/S1_GRD') \
        .filterBounds(aoi) \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')) \
        .filter(dry_season_filter()) \
        .select('VH').median()
    dry_samples = dry_composite.reduceRegions(collection=points_fc, reducer=ee.Reducer.first(), scale=30).getInfo()
    dry_baseline_by_pid = {}
    for f in dry_samples.get('features', []):
        props = f.get('properties', {})
        pid = props.get('pid')
        vh_raw = props.get('VH')  # already dB
        if pid is not None and vh_raw is not None:
            dry_baseline_by_pid[pid] = round(vh_raw, 2)

    print(f"  [GEE] Reference baselines: pre-event for {len(pre_event_by_pid)}/{num_points} points, dry-season for {len(dry_baseline_by_pid)}/{num_points} points", file=sys.stderr)

    def per_image(img):
        img = ee.Image(img)
        band_names = img.bandNames()
        has_vv = band_names.contains('VV')
        img2 = ee.Image(ee.Algorithms.If(
            has_vv,
            img.select(['VH', 'VV']),
            img.select(['VH']).addBands(
                ee.Image.constant(0).rename('VV').updateMask(ee.Image.constant(0))
            )
        ))
        date_str = img.date().format('YYYY-MM-dd')
        orbit = img.get('orbitProperties_pass')
        sampled = img2.reduceRegions(collection=points_fc, reducer=ee.Reducer.first(), scale=30)
        return sampled.map(lambda f: f.set('date', date_str, 'orbit', orbit))

    all_samples = ee.FeatureCollection(s1.map(per_image)).flatten().getInfo()  # ONE round-trip

    # Group sampled rows by point id
    by_point = {}
    for f in all_samples.get('features', []):
        props = f.get('properties', {})
        pid = props.get('pid')
        if pid is None:
            continue
        geom = f.get('geometry', {}).get('coordinates')
        entry = by_point.setdefault(pid, {'coords': geom, 'passes': []})
        if geom and not entry['coords']:
            entry['coords'] = geom

        vh_raw = props.get('VH')  # already dB
        vv_raw = props.get('VV')  # already dB
        vh_db = round(vh_raw, 2) if vh_raw is not None else None
        vv_db = round(vv_raw, 2) if vv_raw is not None else None
        entry['passes'].append({'date': props.get('date'), 'vhDb': vh_db, 'vvDb': vv_db})

    result_points = []
    for pid, entry in by_point.items():
        coords = entry['coords']
        if not coords:
            continue
        passes = entry['passes']
        passes.sort(key=lambda p: p['date'] or '')
        valid = [p for p in passes if p['vhDb'] is not None]
        # Adaptive classification preferring this point's own immediate
        # pre-event baseline, then its dry-season baseline, then a
        # within-window median as last resort -- the whole reason a real
        # flood like the one reported for Vijayawada, where the ENTIRE
        # query window was itself the flood period, could get missed by
        # comparing passes only to each other.
        window_median = statistics.median([p['vhDb'] for p in valid]) if len(valid) >= MIN_PASSES_FOR_BASELINE else None
        point_baseline, point_baseline_source = pick_baseline(
            pre_event_by_pid.get(pid), dry_baseline_by_pid.get(pid), window_median
        )
        flags, _, _ = classify_floods([p['vhDb'] for p in passes], dry_baseline=point_baseline)
        flooded_dates = [p['date'] for p, flagged in zip(passes, flags) if flagged and p['date']]
        events = cluster_flood_events(flooded_dates)
        valid_vh = [p['vhDb'] for p in passes if p['vhDb'] is not None]
        valid_vv = [p['vvDb'] for p in passes if p.get('vvDb') is not None]
        avg_vh = round(sum(valid_vh) / len(valid_vh), 2) if valid_vh else None
        avg_vv = round(sum(valid_vv) / len(valid_vv), 2) if valid_vv else None
        result_points.append({
            'lat': round(coords[1], 6),
            'lng': round(coords[0], 6),
            'totalPasses': len(passes),
            'validPasses': len(valid),
            'baselineVhDb': point_baseline,
            'baselineSource': point_baseline_source,
            'avgVhDb': avg_vh,
            'avgVvDb': avg_vv,
            'floodEventCount': len(events),
            'floodEvents': events,
            'floodPercentage': round(len(flooded_dates) / len(valid) * 100, 1) if valid else 0,
        })

    # Most-affected points first — makes it obvious where to look for
    # recurring problems (e.g. drainage issues worth checking in Street View).
    result_points.sort(key=lambda p: p['floodEventCount'], reverse=True)

    flooded_points = [p for p in result_points if p['floodEventCount'] > 0]

    # Merge every point's flood events into ONE boundary-wide timeline so
    # the answer to "did floods happen in this boundary during this
    # period, and when" doesn't require clicking into individual points.
    all_events = [ev for p in flooded_points for ev in p['floodEvents']]
    boundary_timeline = merge_date_ranges(all_events)

    # Boundary-wide rainfall corroboration -- CHIRPS measures rain every
    # day regardless of SAR coverage, so it can flag a likely flood the
    # radar simply never had a pass close enough to confirm.
    rainfall = get_rainfall_series(aoi.centroid(1), start_date, end_date)
    # Use the union of all satellite-pass dates actually seen anywhere in
    # the boundary (recovered from total_images date range via a quick
    # pass-date list is unnecessary here -- boundary_timeline coverage is
    # already SAR-confirmed by definition, so we only need to know if a
    # rainfall event falls entirely outside every confirmed flood period).
    rainfall['crossReference'] = []
    for ev in rainfall.get('rainfallEvents', []):
        ev_end = datetime.strptime(ev['end'], '%Y-%m-%d').date()
        confirmed = any(
            datetime.strptime(fp['start'], '%Y-%m-%d').date() - timedelta(days=SAR_CONFIRMATION_WINDOW_DAYS) <= ev_end <=
            datetime.strptime(fp['end'], '%Y-%m-%d').date() + timedelta(days=SAR_CONFIRMATION_WINDOW_DAYS)
            for fp in boundary_timeline
        )
        rainfall['crossReference'].append({
            'start': ev['start'], 'end': ev['end'],
            'sarConfirmedNearby': confirmed, 'daysToNearestSarPass': None,
        })
    unconfirmed_rain_events = [r for r in rainfall['crossReference'] if not r['sarConfirmedNearby']]

    # Third, fully independent source: real documented flood events
    # (Global Flood Database) intersecting this exact boundary and range.
    historical_record = get_historical_flood_record(aoi, start_date, end_date)

    result = {
        'startDate': start_date,
        'endDate': end_date,
        'totalImages': total_images,
        'numPoints': num_points,
        'points': result_points,
        'floodedPointCount': len(flooded_points),
        'maxEventCount': max((p['floodEventCount'] for p in result_points), default=0),
        'floodOccurred': len(flooded_points) > 0,
        'boundaryFloodPeriods': boundary_timeline,
        'rainfall': rainfall,
        'historicalRecord': historical_record,
        'likelyUncapturedFlood': len(flooded_points) == 0 and (len(unconfirmed_rain_events) > 0 or historical_record.get('matched', False)),
        'dataSource': 'Real Sentinel-1 SAR + CHIRPS rainfall + Global Flood Database — NOT AI generated',
    }
    print(f"  [GEE] Region scan done: {len(flooded_points)}/{len(result_points)} sample points show at least one flood event", file=sys.stderr)
    print(f"  [GEE] Rainfall: {rainfall.get('heavyRainDays',0)} heavy-rain day(s), {len(unconfirmed_rain_events)} not confirmed by SAR", file=sys.stderr)
    return result


def validate_dates(start_date, end_date, max_days=365):
    try:
        start = datetime.strptime(start_date, '%Y-%m-%d').date()
        end = datetime.strptime(end_date, '%Y-%m-%d').date()
    except ValueError:
        return "Invalid date format"
    today = datetime.now().date()
    min_date = datetime(2017, 1, 1).date()
    if start < min_date or end < min_date:
        return "Dates cannot be before 2017-01-01"
    if start > today or end > today:
        return "Dates cannot be in the future"
    if start > end:
        return "Start date must be before end date"
    if max_days and (end - start).days > max_days:
        years = round(max_days / 365, 1)
        return f"Range cannot exceed {max_days} days (~{years} years) for this analysis type"
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', help='KML/KMZ file for area analysis')
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--key', default='ee-key.json')
    parser.add_argument('--export-csv', default='false')
    parser.add_argument('--sample', action='store_true', help='Query single point frequency')
    parser.add_argument('--lat', type=float, help='Latitude for point query')
    parser.add_argument('--lng', type=float, help='Longitude for point query')
    parser.add_argument('--region-frequency', action='store_true', help='Scan a boundary for recurring flood points over the date range')
    parser.add_argument('--coords', help='JSON array of [lng,lat] pairs describing the boundary polygon (for --region-frequency)')
    parser.add_argument('--num-points', type=int, default=25, help='Number of sample points to scan within the boundary')
    args = parser.parse_args()

    # Multi-year point/region frequency scans are the whole point of this
    # feature, so they get a much larger allowed range (up to 10 years)
    # than the single-snapshot before/after area mosaic below, where a
    # multi-year mosaic wouldn't be meaningful anyway.
    if args.sample or args.region_frequency:
        max_days = 3650
    else:
        max_days = 365

    error = validate_dates(args.start, args.end, max_days=max_days)
    if error:
        print(json.dumps({"error": error}))
        sys.exit(1)

    if args.sample:
        if args.lat is None or args.lng is None:
            print(json.dumps({"error": "--lat and --lng required for --sample mode"}))
            sys.exit(1)
        print("  [GEE] Querying point frequency...", file=sys.stderr)
        result = sample_point_frequency(args.lat, args.lng, args.start, args.end, args.key)
        print(json.dumps(result))
    elif args.region_frequency:
        if not args.coords:
            print(json.dumps({"error": "--coords required for --region-frequency mode"}))
            sys.exit(1)
        try:
            coords = json.loads(args.coords)
        except Exception:
            print(json.dumps({"error": "--coords must be a JSON array of [lng,lat] pairs"}))
            sys.exit(1)
        print("  [GEE] Scanning boundary for flood frequency...", file=sys.stderr)
        result = sample_region_frequency(coords, args.start, args.end, args.key, args.num_points)
        print(json.dumps(result))
    else:
        if not args.file:
            print(json.dumps({"error": "--file required for area analysis"}))
            sys.exit(1)
        print("  [GEE] Initializing Earth Engine...", file=sys.stderr)
        initialize_ee(args.key)
        print(f"  [GEE] Parsing KML: {args.file}", file=sys.stderr)
        geo = parse_kml(args.file)
        result = detect_floods_and_export(geo['bounds'], geo['coords'], args.start, args.end, args.export_csv.lower() == 'true')
        print(json.dumps(result))


if __name__ == '__main__':
    main()
