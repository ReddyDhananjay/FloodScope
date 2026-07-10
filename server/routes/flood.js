import { Router } from 'express';
import { FloodPoint } from '../models/FloodPoint.js';
import { Dataset } from '../models/Dataset.js';

export const floodRouter = Router();

/**
 * GET /api/flood/stats
 * Returns dataset statistics (total, flooded, events, etc.)
 */
floodRouter.get('/stats', async (req, res) => {
  try {
    const ds = await Dataset.findOne().sort({ importedAt: -1 });
    if (!ds) {
      return res.json({ loaded: false, message: 'No dataset imported yet' });
    }
    res.json({
      loaded: true,
      mode: ds.mode,
      totalPoints: ds.totalPoints,
      floodedPoints: ds.floodedPoints,
      neverFlooded: ds.neverFlooded,
      eventCount: ds.eventCount,
      eventNames: ds.eventNames,
      eventCounts: ds.eventCounts,
      latRange: ds.latRange,
      lngRange: ds.lngRange,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/flood/heatmap?event=-1
 * Returns aggregated heatmap data (lat, lng, weight)
 * event=-1 means flood frequency (all years)
 * event=N means specific event index
 */
floodRouter.get('/heatmap', async (req, res) => {
  try {
    const eventIdx = parseInt(req.query.event || '-1');

    let points;
    if (eventIdx === -1) {
      // Frequency heatmap - only flooded points, weight = frequency
      points = await FloodPoint.find({ freq: { $gt: 0 } })
        .select('lat lng freq -_id')
        .lean();
      points = points.map(p => [p.lat, p.lng, Math.max(0.4, p.freq)]);
    } else {
      // Specific event - only points flooded in that event
      points = await FloodPoint.find({ [`flags.${eventIdx}`]: true })
        .select('lat lng -_id')
        .lean();
      points = points.map(p => [p.lat, p.lng, 1]);
    }

    res.json({ points, count: points.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/flood/point/:fid
 * Returns a single flood point by its FID
 */
floodRouter.get('/point/:fid', async (req, res) => {
  try {
    const fid = parseInt(req.params.fid);
    const point = await FloodPoint.findOne({ fid }).lean();
    if (!point) return res.status(404).json({ error: 'Point not found' });
    res.json(point);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/flood/nearest?lat=16.5&lng=80.6
 * Returns the nearest flood point to given coordinates
 */
floodRouter.get('/nearest', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng required' });
    }

    // Use MongoDB aggregation to find nearest point
    const result = await FloodPoint.aggregate([
      {
        $addFields: {
          distSq: {
            $add: [
              { $pow: [{ $subtract: ['$lng', lng] }, 2] },
              { $pow: [{ $subtract: ['$lat', lat] }, 2] },
            ],
          },
        },
      },
      { $sort: { distSq: 1 } },
      { $limit: 1 },
    ]);

    if (!result.length) {
      return res.status(404).json({ error: 'No points found' });
    }

    const p = result[0];
    res.json({
      fid: p.fid,
      lat: p.lat,
      lng: p.lng,
      freq: p.freq || 0,
      flags: p.flags || [],
      title: p.title || '',
      raw: p.raw || {},
      distanceMeters: Math.round(Math.sqrt(p.distSq) * 111139),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/flood/hotspots?limit=12
 * Returns the top N most-flooded points
 */
floodRouter.get('/hotspots', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '12');
    const points = await FloodPoint.find({ freq: { $gt: 0 } })
      .sort({ freq: -1 })
      .limit(limit)
      .select('fid lat lng freq -_id')
      .lean();
    res.json({ hotspots: points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
