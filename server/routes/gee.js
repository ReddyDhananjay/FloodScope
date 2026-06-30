import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

export const geeRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const tempKml = path.join(__dirname, '..', 'uploads', `polygon_${Date.now()}.kml`);
  const coordsXml = coordinates.map(c => `${c[0]},${c[1]},0`).join(' ');
  const kmlContent = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsXml}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;

  try {
    writeFileSync(tempKml, kmlContent);
  } catch (e) {
    return res.status(500).json({ error: 'Could not create temp file: ' + e.message });
  }

  const eeKey = process.env.EE_SERVICE_ACCOUNT_KEY || path.join(__dirname, '..', '..', 'ee-key.json');

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
  const eeKey = process.env.EE_SERVICE_ACCOUNT_KEY || path.join(__dirname, '..', '..', 'ee-key.json');

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
      res.status(504).json({ error: 'Analysis timed out (120s)' });
    }
  }, 120000);

  python.on('close', (code) => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;

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
    res.status(500).json({ error: 'Python error: ' + err.message });
  });
}

/**
 * GET /api/gee/status
 */
geeRouter.get('/status', async (req, res) => {
  const keyPath = process.env.EE_SERVICE_ACCOUNT_KEY || path.join(__dirname, '..', '..', 'ee-key.json');
  try {
    existsSync(keyPath);
    res.json({ configured: true });
  } catch {
    res.json({ configured: false, message: 'Run earthengine authenticate' });
  }
});
