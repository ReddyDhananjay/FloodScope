import { mongoose } from '../db.js';

const floodPointSchema = new mongoose.Schema({
  fid: { type: Number, required: true, index: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  freq: { type: Number, default: 0 },
  flags: { type: [Boolean], default: [] },
  events: { type: [String], default: [] },
  // Store ALL raw columns from the CSV for any file type
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  // For display: the title (first text column)
  title: { type: String, default: '' },
  importedAt: { type: Date, default: Date.now },
});

// Geo index for location queries
floodPointSchema.index({ lat: 1, lng: 1 });

export const FloodPoint = mongoose.model('FloodPoint', floodPointSchema);
