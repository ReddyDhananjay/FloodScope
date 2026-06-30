#!/usr/bin/env python3
"""
Google Earth Engine - Flood Detection + CSV Export
Detects floods using Sentinel-1 SAR and exports point data as CSV.

Usage:
  python3 gee.py --file area.kml --start 2024-08-25 --end 2024-09-05 --key ee-key.json --export-csv true
"""
import ee
import json
import csv
import argparse
import sys
import zipfile
import xml.etree.ElementTree as ET
import os
import io
def initialize_ee(key_path):
    """
    Initialize Google Earth Engine.
    """

    try:
        # Try Render environment variable first
        env_key = os.environ.get("EE_SERVICE_ACCOUNT_KEY")

        if env_key:
            key = json.loads(env_key)

            credentials = ee.ServiceAccountCredentials(
                key["client_email"],
                key_data=json.dumps(key)
            )

            ee.Initialize(credentials)
            print("  [GEE] Authenticated using Render environment variable", file=sys.stderr)
            return

        # Try local JSON file
        if os.path.exists(key_path):
            with open(key_path, "r") as f:
                key = json.load(f)

            credentials = ee.ServiceAccountCredentials(
                key["client_email"],
                key_file=key_path
            )

            ee.Initialize(credentials)
            print("  [GEE] Authenticated using local JSON file", file=sys.stderr)
            return

    except Exception as e:
        print(f"  [GEE] Service account authentication failed: {e}", file=sys.stderr)

    try:
        ee.Initialize()
        print("  [GEE] Authenticated using default credentials", file=sys.stderr)
        return

    except Exception as e:
        print(f"  [GEE] Could not initialize Earth Engine: {e}", file=sys.stderr)
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

    # Load Sentinel-1 SAR
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

    # Reference (previous year)
    from datetime import datetime, timedelta
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

    # ===== Tile layer =====
    flood_vis = flood.visualize(min=0, max=1, palette=['ffffff00', '0066ff'], opacity=0.6)
    tile_url = None
    try:
        map_id = flood_vis.getMapId({})
        tile_url = map_id['tile_fetcher'].url_format
        print(f"  [GEE] Tile layer generated", file=sys.stderr)
    except Exception as e:
        print(f"  [GEE] Tile failed: {e}", file=sys.stderr)

    # ===== Flood area =====
    area_km2 = 0
    try:
        flood_area = flood.multiply(ee.Image.pixelArea()).reduceRegion(
            reducer=ee.Reducer.sum(), geometry=aoi, scale=30, maxPixels=1e9).getInfo()
        area_m2 = flood_area.get('flood', 0) if flood_area else 0
        area_km2 = round(area_m2 / 1e6, 2)
        print(f"  [GEE] Flooded area: {area_km2} km²", file=sys.stderr)
    except Exception as e:
        print(f"  [GEE] Area calc failed: {e}", file=sys.stderr)

    # ===== Sample points for CSV export =====
    csv_data = ''
    point_count = 0
    if export_csv:
        try:
            # Sample the flood image at regular grid points within the AOI
            samples = flood.stratifiedSample(
                numPoints=500,
                classBand='flood',
                region=aoi,
                scale=100,
                seed=42,
                geometries=True,
            ).getInfo()

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--key', default='ee-key.json')
    parser.add_argument('--export-csv', default='false')
    args = parser.parse_args()

    error = validate_dates(args.start, args.end)
    if error:
        print(json.dumps({"error": error}))
        sys.exit(1)

    print("  [GEE] Initializing Earth Engine...", file=sys.stderr)
    initialize_ee(args.key)

    print(f"  [GEE] Parsing KML: {args.file}", file=sys.stderr)
    geo = parse_kml(args.file)

    result = detect_floods_and_export(geo['bounds'], geo['coords'], args.start, args.end, args.export_csv.lower() == 'true')
    print(json.dumps(result))


def validate_dates(start_date, end_date):
    from datetime import datetime, date
    try:
        start = datetime.strptime(start_date, '%Y-%m-%d').date()
        end = datetime.strptime(end_date, '%Y-%m-%d').date()
    except ValueError:
        return "Invalid date format"
    today = date.today()
    min_date = date(2017, 1, 1)
    if start < min_date or end < min_date:
        return "Dates cannot be before 2017-01-01"
    if start > today or end > today:
        return f"Dates cannot be in the future"
    if start > end:
        return "Start date must be before end date"
    if (end - start).days > 365:
        return "Range cannot exceed 365 days"
    return None


if __name__ == '__main__':
    main()
