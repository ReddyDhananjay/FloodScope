import { mongoose } from '../db.js';

const datasetSchema = new mongoose.Schema({
  name: { type: String, default: 'Vijayawada Floods' },
  mode: { type: String, enum: ['flood', 'generic'], default: 'flood' },
  totalPoints: { type: Number, default: 0 },
  floodedPoints: { type: Number, default: 0 },
  neverFlooded: { type: Number, default: 0 },
  eventCount: { type: Number, default: 0 },
  eventNames: { type: [String], default: [] },
  eventCounts: { type: [Number], default: [] },
  latRange: { type: [Number], default: [] },
  lngRange: { type: [Number], default: [] },
  importedAt: { type: Date, default: Date.now },
});

export const Dataset = mongoose.model('Dataset', datasetSchema);
