import { Router } from 'express';
import { FloodPoint } from '../models/FloodPoint.js';
import { Dataset } from '../models/Dataset.js';

export const importRouter = Router();

const FM = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SM = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function prettyEvent(name) {
  const m = name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)_(\d{4})/i);
  if (m) return SM[FM.indexOf(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase())] + ' ' + m[2];
  return name.replace(/^.*?Flood_/i, '').replace(/_/g, ' ');
}

/* Smart column detection - handles ANY CSV format */
function detectColumns(header, sampleRows) {
  const norm = h => h.toLowerCase().trim().replace(/[^a-z0-9]/g, '');

  let latI = -1, lonI = -1;

  // === LATITUDE detection ===
  const latPatterns = ['latitude', 'lat', 'lati', 'ycoord', 'ycoord', 'y'];
  header.forEach((h, i) => {
    const n = norm(h);
    if (latI >= 0) return;
    // Match by name
    if (latPatterns.includes(n) || n.startsWith('lat')) latI = i;
  });

  // === LONGITUDE detection ===
  const lonPatterns = ['longitude', 'lon', 'lng', 'long', 'longi', 'xcoord', 'xcoord', 'x', 'longtitude'];
  header.forEach((h, i) => {
    const n = norm(h);
    if (lonI >= 0) return;
    if (lonPatterns.includes(n) || n.startsWith('lon') || n.startsWith('lng')) lonI = i;
  });

  // === Fallback: detect by data values ===
  if (latI < 0 || lonI < 0) {
    // Check each column: which looks like lat (-90 to 90) and which like lng (-180 to 180)
    const colStats = header.map((_, i) => {
      let min = Infinity, max = -Infinity, count = 0;
      sampleRows.forEach(r => {
        const v = parseFloat(r[i]);
        if (isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); count++; }
      });
      return { i, min, max, count };
    }).filter(c => c.count > 0);

    // Latitude range: -90 to 90
    // Longitude range: -180 to 180
    if (latI < 0) {
      const latCol = colStats.find(c => c.min >= -90 && c.max <= 90);
      if (latCol) latI = latCol.i;
    }
    if (lonI < 0) {
      // Pick a numeric column that's not the lat column
      const lngCol = colStats.find(c => c.i !== latI && c.min >= -180 && c.max <= 180);
      if (lngCol) lonI = lngCol.i;
    }

    // Last resort: first two numeric columns
    if (latI < 0 || lonI < 0) {
      const nums = colStats.filter(c => c.i !== latI && c.i !== lonI);
      if (latI < 0 && nums.length > 0) latI = nums[0].i;
      if (lonI < 0 && nums.length > 1) lonI = nums[1].i;
    }
  }

  if (latI === lonI) { lonI = latI + 1; }
  if (latI < 0) latI = 0;
  if (lonI < 0) lonI = 1;

  // === Title column: first non-coordinate text column ===
  let titleI = -1;
  header.forEach((h, i) => {
    if (titleI >= 0 || i === latI || i === lonI) return;
    const val = (sampleRows[0] && sampleRows[0][i] || '').trim();
    if (val && isNaN(parseFloat(val))) titleI = i;
  });

  // === Flood event columns: columns with year or "flood" in name ===
  const evI = [];
  header.forEach((h, i) => {
    if (i === latI || i === lonI) return;
    if (/(?:^|_)(19|20)\d{2}/.test(h) || /flood/i.test(h)) evI.push(i);
  });

  return { latI, lonI, titleI, evI };
}

function parseLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

/**
 * POST /api/import/csv
 * Handles ANY CSV file with latitude/longitude columns.
 * Auto-detects column names and data format.
 */
importRouter.post('/csv', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'CSV content required' });

    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

    // Find header (first row with >=2 columns)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (parseLine(lines[i]).length >= 2) { headerIdx = i; break; }
    }

    const header = parseLine(lines[headerIdx]);
    const body = lines.slice(headerIdx + 1).map(parseLine);

    // Use first 20 rows to detect columns
    const sample = body.slice(0, 20);
    const { latI, lonI, titleI, evI } = detectColumns(header, sample);

    const MODE = evI.length >= 3 ? 'flood' : 'generic';
    const fidI = header.findIndex(h => /^(fid|id|point.?id|index|no|num)$/i.test(h.trim()));

    // Clear old data
    await FloodPoint.deleteMany({});
    await Dataset.deleteMany({});

    const BATCH = 5000;
    let batch = [];
    let total = 0, flooded = 0;
    const evCounts = new Array(evI.length).fill(0);
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;

    for (const r of body) {
      const lat = parseFloat(r[latI]);
      const lng = parseFloat(r[lonI]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);

      // Store ALL raw columns
      const raw = {};
      header.forEach((h, i) => { raw[h] = r[i] || ''; });

      const title = titleI >= 0 ? (r[titleI] || '').trim() : '';

      const doc = {
        fid: fidI >= 0 ? parseInt(r[fidI]) || (total + 1) : (total + 1),
        lat, lng, raw, title,
      };

      if (MODE === 'flood') {
        const flags = evI.map(i => {
          const v = (r[i] || '0').trim();
          return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes' || parseFloat(v) >= 1;
        });
        const freq = flags.reduce((a, b) => a + (b ? 1 : 0), 0);
        flags.forEach((b, i) => { if (b) evCounts[i]++; });
        if (freq > 0) flooded++;
        doc.freq = freq;
        doc.flags = flags;
        doc.events = evI.map(i => header[i]);
      }

      batch.push(doc);
      total++;

      if (batch.length >= BATCH) {
        await FloodPoint.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await FloodPoint.insertMany(batch, { ordered: false });

    if (total === 0) {
      return res.status(400).json({ error: 'No valid coordinate rows found. Make sure your CSV has latitude and longitude columns.' });
    }

    // Store dataset metadata
    const dsName = titleI >= 0 ? header[titleI] : 'Imported Data';
    await Dataset.create({
      name: dsName,
      mode: MODE,
      totalPoints: total,
      floodedPoints: flooded,
      neverFlooded: total - flooded,
      eventCount: evI.length,
      eventNames: evI.map(i => prettyEvent(header[i])),
      eventCounts: evCounts,
      latRange: [minLat, maxLat],
      lngRange: [minLng, maxLng],
    });

    // Return detailed info
    res.json({
      success: true,
      mode: MODE,
      totalPoints: total,
      floodedPoints: flooded,
      neverFlooded: total - flooded,
      eventCount: evI.length,
      detected: {
        latColumn: header[latI],
        lonColumn: header[lonI],
        titleColumn: titleI >= 0 ? header[titleI] : null,
        allColumns: header,
        mode: MODE,
        description: MODE === 'flood'
          ? `Flood data detected with ${evI.length} flood events`
          : `Generic location data with ${header.length} columns`,
      },
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/import/status
 */
importRouter.get('/status', async (req, res) => {
  try {
    const count = await FloodPoint.countDocuments();
    const ds = await Dataset.findOne().sort({ importedAt: -1 });
    res.json({
      hasData: count > 0,
      pointCount: count,
      dataset: ds ? ds.name : null,
      mode: ds ? ds.mode : null,
      importedAt: ds ? ds.importedAt : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
