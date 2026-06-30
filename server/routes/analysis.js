import { Router } from 'express';
import { Analysis } from '../models/Analysis.js';

export const analysisRouter = Router();

// --- Geography constants ---
const BUDAMERU_PATH = [
  [16.56, 80.575], [16.55, 80.58], [16.54, 80.585], [16.53, 80.588],
  [16.52, 80.59], [16.512, 80.595], [16.505, 80.60], [16.50, 80.61],
  [16.495, 80.62], [16.49, 80.635], [16.485, 80.65], [16.482, 80.67],
];
const KRISHNA_PATH = [
  [16.4787, 80.60], [16.485, 80.605], [16.49, 80.61], [16.495, 80.615],
  [16.50, 80.62], [16.5063, 80.625], [16.51, 80.63], [16.515, 80.64],
  [16.52, 80.65], [16.525, 80.66], [16.53, 80.675],
];
const PRAKASAM_BARRAGE = [16.5063, 80.605];
const FLOOD_AREAS = {
  'Singh Nagar': [16.515, 80.588], 'Gollapudi': [16.525, 80.585],
  'Ajit Singh Nagar': [16.530, 80.590], 'Payakapuram': [16.535, 80.592],
  'Kandrika': [16.520, 80.595], 'Nunna': [16.545, 80.580],
  'Sundaraiah Nagar': [16.518, 80.586], 'Bhavani Puram': [16.510, 80.590],
  'Jakkampudi': [16.525, 80.600], 'Vidyadhara Puram': [16.512, 80.592],
};

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = d => d * Math.PI / 180;
  const dLat = t(lat2 - lat1), dLng = t(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function distToPath(lat, lng, path) {
  let min = Infinity;
  for (const p of path) {
    const d = haversine(lat, lng, p[0], p[1]);
    if (d < min) min = d;
  }
  return min;
}
function nearestArea(lat, lng) {
  let best = null, bestD = Infinity;
  for (const [name, c] of Object.entries(FLOOD_AREAS)) {
    const d = haversine(lat, lng, c[0], c[1]);
    if (d < bestD) { bestD = d; best = name; }
  }
  return { name: best, dist: bestD };
}

function generateCauses(lat, lng, freq, dB, dK, dBar, areaName) {
  const causes = [];
  if (dB < 1500) {
    const sev = dB < 600 ? 'high' : (dB < 1000 ? 'med' : 'low');
    causes.push({
      severity: sev,
      title: 'Budameru Rivulet Overflow',
      description: `This point is ${Math.round(dB)}m from the Budameru Rivulet ("Sorrow of Vijayawada"). When inflows exceed 35,000 cusecs, the diversion canal (capacity 7,000) overflows and breaches. If Krishna River is high, water backs up into the city.${dB < 500 ? ' Directly in the Budameru floodplain.' : ''}`,
    });
  }
  if (dK < 1500) {
    const sev = dK < 600 ? 'high' : (dK < 1000 ? 'med' : 'low');
    causes.push({
      severity: sev,
      title: 'Krishna River & Prakasam Barrage',
      description: `This point is ${Math.round(dK)}m from the Krishna River. During heavy monsoons, Prakasam Barrage (${Math.round(dBar)}m away) releases over 1.1 million cusecs. Sept 2024 saw record 1.18 million cusecs.`,
    });
  }
  if (freq > 0) {
    causes.push({
      severity: 'med',
      title: 'Heavy Monsoon Rainfall (Jul-Oct)',
      description: 'Intense rainfall during southwest monsoon from Bay of Bengal low-pressure systems. Record 37cm in one day Sept 2024.',
    });
  }
  if (freq >= 3) {
    causes.push({
      severity: 'low',
      title: 'Urban Encroachment & Drainage',
      description: `Flooded ${freq} times = recurring drainage problems. Encroachment on Budameru floodplains reduced natural water-carrying capacity.`,
    });
  }
  causes.push({
    severity: 'low',
    title: 'Low-Lying Topography',
    description: `Vijayawada sits between Krishna River and surrounding hills. Areas near ${areaName} are vulnerable to runoff collection.`,
  });
  return causes;
}

/**
 * GET /api/analysis/:lat/:lng
 * Returns stored analysis for a point, or generates and stores it
 */
analysisRouter.get('/:lat/:lng', async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat);
    const lng = parseFloat(req.params.lng);
    const freq = parseInt(req.query.freq || '0');

    // Round to 5 decimal places for matching
    const latR = Math.round(lat * 1e5) / 1e5;
    const lngR = Math.round(lng * 1e5) / 1e5;

    // Check if analysis already exists in DB
    let analysis = await Analysis.findOne({ lat: latR, lng: lngR }).lean();

    if (analysis) {
      return res.json({ ...analysis, cached: true });
    }

    // Generate new analysis
    const dB = distToPath(lat, lng, BUDAMERU_PATH);
    const dK = distToPath(lat, lng, KRISHNA_PATH);
    const dBar = haversine(lat, lng, PRAKASAM_BARRAGE[0], PRAKASAM_BARRAGE[1]);
    const area = nearestArea(lat, lng);
    const causes = generateCauses(lat, lng, freq, dB, dK, dBar, area.name);

    // Save to database
    analysis = await Analysis.create({
      lat: latR,
      lng: lngR,
      geo: {
        dBudameru: Math.round(dB),
        dKrishna: Math.round(dK),
        dBarrage: Math.round(dBar),
        nearestArea: area.name,
        nearestAreaDist: Math.round(area.dist),
        floodFreq: freq,
      },
      causes,
    });

    res.json({ ...analysis.toObject(), cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/analysis/:lat/:lng/ai
 * Stores AI analysis result for a point
 */
analysisRouter.post('/:lat/:lng/ai', async (req, res) => {
  try {
    const lat = Math.round(parseFloat(req.params.lat) * 1e5) / 1e5;
    const lng = Math.round(parseFloat(req.params.lng) * 1e5) / 1e5;
    const { analysis, model } = req.body;

    if (!analysis) return res.status(400).json({ error: 'analysis text required' });

    const updated = await Analysis.findOneAndUpdate(
      { lat, lng },
      { aiAnalysis: analysis, aiModel: model || 'deepseek-v4-pro' },
      { upsert: true, new: true }
    );

    res.json({ saved: true, id: updated._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analysis/all
 * Returns all stored analyses (for admin/stats)
 */
analysisRouter.get('/all', async (req, res) => {
  try {
    const analyses = await Analysis.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const total = await Analysis.countDocuments();
    const withAI = await Analysis.countDocuments({ aiAnalysis: { $ne: null } });
    res.json({ total, withAI, analyses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
