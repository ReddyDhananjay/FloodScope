import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';

export const geeRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = path.join(__dirname, '..', '..', 'ee-key.json');
const TEMP_KEY_PATH = path.join(os.tmpdir(), 'floodscope-ee-key.json');

/**
 * Resolve the Earth Engine service-account key to a file path that
 * server/gee.py can read.
 *
 * EE_SERVICE_ACCOUNT_KEY can be set two different ways depending on
 * where the app is running:
 *  - Locally: a file path to the key JSON (e.g. "ee-key.json" or an
 *    absolute path). Most hosts with a persistent filesystem use this.
 *  - On hosts with an ephemeral filesystem (e.g. Render), there's
 *    nowhere to upload the key file, so the full JSON content is
 *    pasted directly into the env var instead. In that case we write
 *    it out to a temp file once and hand gee.py that path.
 * If the env var isn't set at all, we fall back to a local ee-key.json
 * in the project root (for `earthengine authenticate` / dev setups).
 */
function resolveEeKey() {
  const value = process.env.EE_SERVICE_ACCOUNT_KEY;

  if (!value) return DEFAULT_KEY_PATH;

  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    // Raw JSON content in the env var — write it to a temp file for gee.py to read.
    try {
      writeFileSync(TEMP_KEY_PATH, trimmed);
      return TEMP_KEY_PATH;
    } catch (e) {
      console.error('  ❌ Could not write EE key to temp file:', e.message);
      return DEFAULT_KEY_PATH;
    }
  }

  // Otherwise treat it as a file path
  return value;
}

/**
 * POST /api/gee/analyze-polygon
 * Body: { coordinates: [[lng,lat],[lng,lat],...], startDate, endDate }
 * Accepts polygon drawn on map (no file upload needed)
 */
export async function handleGeePolygon(req, res) {
  const { coordinates, startDate, endDate } = req.body;

  if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'Draw a polygon with at least 3 points on the map first' });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Select both start and end dates' });
  }

  // Validate dates
  const startD = new Date(startDate);
  const endD = new Date(endDate);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const minDate = new Date('2017-01-01');

  if (startD < minDate || endD < minDate) {
    return res.status(400).json({ error: 'Dates cannot be before 1 Jan 2017' });
  }
  if (startD > today || endD > today) {
    return res.status(400).json({ error: 'Dates cannot be in the future' });
  }
  if (startD > endD) {
    return res.status(400).json({ error: 'Start date must be before end date' });
  }

  // Save coordinates as temp KML for the Python script
  const uploadDir = path.join(__dirname, '..', 'uploads');
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const tempKml = path.join(uploadDir, `polygon_${Date.now()}.kml`);
  const coordsXml = coordinates.map(c => `${c[0]},${c[1]},0`).join(' ');
  const kmlContent = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsXml}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;

  try {
    writeFileSync(tempKml, kmlContent);
  } catch (e) {
    return res.status(500).json({ error: 'Could not create temp file: ' + e.message });
  }

  const eeKey = resolveEeKey();

  console.log(`  🌍 GEE Polygon Analysis: ${coordinates.length} points, ${startDate} to ${endDate}`);

  const scriptPath = path.join(__dirname, '..', 'gee.py');
  const python = spawn('python3', [scriptPath, '--file', tempKml, '--start', startDate, '--end', endDate, '--key', eeKey, '--export-csv', 'true']);

  let stdout = '';
  let stderr = '';
  let responded = false;

  python.stdout.on('data', (data) => { stdout += data.toString(); });
  python.stderr.on('data', (data) => {
    stderr += data.toString();
    console.error('  [GEE]', data.toString().trim());
  });

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      python.kill('SIGTERM');
      try { unlinkSync(tempKml); } catch {}
      res.status(504).json({ error: 'Analysis timed out (120s). Try a smaller area.' });
    }
  }, 120000);

  python.on('close', (code) => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;

    // Clean up temp file
    try { unlinkSync(tempKml); } catch {}

    if (code !== 0) {
      return res.status(500).json({ error: 'Analysis failed', detail: stderr.slice(-400) });
    }

    try {
      const result = JSON.parse(stdout.split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}');
      res.json({ success: true, startDate, endDate, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Could not parse output', raw: stdout.slice(-400) });
    }
  });

  python.on('error', (err) => {
    if (responded) return;
    responded = true;
    try { unlinkSync(tempKml); } catch {}
    res.status(500).json({ error: 'Python error: ' + err.message });
  });
}

/**
 * POST /api/gee/analyze (file upload — KML/KMZ)
 */
export async function handleGeeAnalyze(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No KML/KMZ file uploaded' });
  }

  const startDate = req.body.startDate;
  const endDate = req.body.endDate;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Select both start and end dates' });
  }

  const startD = new Date(startDate);
  const endD = new Date(endDate);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const minDate = new Date('2017-01-01');

  if (startD < minDate || endD < minDate) {
    return res.status(400).json({ error: 'Dates cannot be before 1 Jan 2017' });
  }
  if (startD > today || endD > today) {
    return res.status(400).json({ error: 'Dates cannot be in the future' });
  }
  if (startD > endD) {
    return res.status(400).json({ error: 'Start date must be before end date' });
  }

  const filePath = req.file.path;
  const eeKey = resolveEeKey();

  console.log(`  🌍 GEE File Analysis: ${req.file.originalname}, ${startDate} to ${endDate}`);

  const scriptPath = path.join(__dirname, '..', 'gee.py');
  const python = spawn('python3', [scriptPath, '--file', filePath, '--start', startDate, '--end', endDate, '--key', eeKey, '--export-csv', 'true']);

  let stdout = '';
  let stderr = '';
  let responded = false;

  python.stdout.on('data', (data) => { stdout += data.toString(); });
  python.stderr.on('data', (data) => {
    stderr += data.toString();
    console.error('  [GEE]', data.toString().trim());
  });

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      python.kill('SIGTERM');
      try { unlinkSync(filePath); } catch {}
      res.status(504).json({ error: 'Analysis timed out (120s)' });
    }
  }, 120000);

  python.on('close', (code) => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;

    // Clean up uploaded temp file
    try { unlinkSync(filePath); } catch {}

    if (code !== 0) {
      return res.status(500).json({ error: 'Analysis failed', detail: stderr.slice(-400) });
    }

    try {
      const result = JSON.parse(stdout.split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}');
      res.json({ success: true, startDate, endDate, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Could not parse output', raw: stdout.slice(-400) });
    }
  });

  python.on('error', (err) => {
    if (responded) return;
    responded = true;
    try { unlinkSync(filePath); } catch {}
    res.status(500).json({ error: 'Python error: ' + err.message });
  });
}

/**
 * POST /api/gee/sample-point
 * Query REAL flood data at a single lat/lng point
 * Body: { lat, lng, startDate, endDate }
 */
export async function handleGeeSamplePoint(req, res) {
  const { lat, lng, startDate, endDate } = req.body;

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'lat and lng required' });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate required' });
  }

  const eeKey = resolveEeKey();
  const scriptPath = path.join(__dirname, '..', 'gee.py');

  console.log(`  📍 GEE Point Query: (${lat}, ${lng}) ${startDate} to ${endDate}`);

  const python = spawn('python3', [
    scriptPath, '--sample',
    '--lat', String(lat),
    '--lng', String(lng),
    '--start', startDate,
    '--end', endDate,
    '--key', eeKey,
  ]);

  let stdout = '';
  let stderr = '';
  let responded = false;

  python.stdout.on('data', (data) => { stdout += data.toString(); });
  python.stderr.on('data', (data) => {
    stderr += data.toString();
    console.error('  [GEE]', data.toString().trim());
  });

  // The per-image query is now a single vectorized Earth Engine call
  // (see gee.py), so this should normally finish in a few seconds even
  // for multi-year ranges. The generous timeout below is just a safety
  // net for unusually large ranges/areas, not the expected case.
  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      python.kill('SIGTERM');
      res.status(504).json({ error: 'Query timed out (90s). Try a shorter date range.' });
    }
  }, 90000);

  python.on('close', (code) => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;

    if (code !== 0) {
      return res.status(500).json({ error: 'Query failed', detail: stderr.slice(-300) });
    }

    try {
      const result = JSON.parse(stdout.split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}');
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Parse error', raw: stdout.slice(-300) });
    }
  });

  python.on('error', (err) => {
    if (responded) return;
    responded = true;
    res.status(500).json({ error: 'Python error: ' + err.message });
  });
}

/**
 * POST /api/gee/analyze-region-frequency
 * Scan a whole boundary for RECURRING flood points over a (possibly
 * multi-year) date range. Returns one entry per sample point with its
 * lat/lng and how many distinct flood events happened there.
 * Body: { coordinates: [[lng,lat],...], startDate, endDate, numPoints? }
 */
export async function handleGeeRegionFrequency(req, res) {
  const { coordinates, startDate, endDate, numPoints } = req.body;

  if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'Draw a polygon with at least 3 points on the map first' });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Select both start and end dates' });
  }

  const startD = new Date(startDate);
  const endD = new Date(endDate);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const minDate = new Date('2017-01-01');

  if (startD < minDate || endD < minDate) {
    return res.status(400).json({ error: 'Dates cannot be before 1 Jan 2017' });
  }
  if (startD > today || endD > today) {
    return res.status(400).json({ error: 'Dates cannot be in the future' });
  }
  if (startD > endD) {
    return res.status(400).json({ error: 'Start date must be before end date' });
  }

  const n = Math.min(Math.max(parseInt(numPoints, 10) || 25, 5), 80);
  const eeKey = resolveEeKey();
  const scriptPath = path.join(__dirname, '..', 'gee.py');

  console.log(`  🔎 GEE Region Frequency Scan: ${coordinates.length}-point boundary, ${n} sample points, ${startDate} to ${endDate}`);

  const python = spawn('python3', [
    scriptPath, '--region-frequency',
    '--coords', JSON.stringify(coordinates),
    '--start', startDate,
    '--end', endDate,
    '--key', eeKey,
    '--num-points', String(n),
  ]);

  let stdout = '';
  let stderr = '';
  let responded = false;

  python.stdout.on('data', (data) => { stdout += data.toString(); });
  python.stderr.on('data', (data) => {
    stderr += data.toString();
    console.error('  [GEE]', data.toString().trim());
  });

  // Longer allowance than the single-point query since this samples
  // several points per satellite pass, but it's still one round trip
  // to Earth Engine (see sample_region_frequency in gee.py), not one
  // per point/image.
  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      python.kill('SIGTERM');
      res.status(504).json({ error: 'Scan timed out (180s). Try fewer sample points or a shorter date range.' });
    }
  }, 180000);

  python.on('close', (code) => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;

    if (code !== 0) {
      return res.status(500).json({ error: 'Scan failed', detail: stderr.slice(-400) });
    }

    try {
      const result = JSON.parse(stdout.split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}');
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Could not parse output', raw: stdout.slice(-400) });
    }
  });

  python.on('error', (err) => {
    if (responded) return;
    responded = true;
    res.status(500).json({ error: 'Python error: ' + err.message });
  });
}

geeRouter.get('/status', async (req, res) => {
  try {
    const keyPath = resolveEeKey();
    const configured = existsSync(keyPath);
    res.json({
      configured,
      message: configured ? undefined : 'No Earth Engine key found. Set EE_SERVICE_ACCOUNT_KEY or run: earthengine authenticate',
    });
  } catch {
    res.json({ configured: false, message: 'Run earthengine authenticate' });
  }
});
