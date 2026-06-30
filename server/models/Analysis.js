import { mongoose } from '../db.js';

const analysisSchema = new mongoose.Schema({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  pointId: { type: Number, index: true },

  // Geographic analysis results
  geo: {
    dBudameru: Number,
    dKrishna: Number,
    dBarrage: Number,
    nearestArea: String,
    nearestAreaDist: Number,
    floodFreq: Number,
  },

  // Cause cards (auto-generated)
  causes: [{
    severity: String,
    title: String,
    description: String,
  }],

  // AI analysis (if generated)
  aiAnalysis: { type: String, default: null },
  aiModel: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
});

// Compound index so we can find by exact coordinates
analysisSchema.index({ lat: 1, lng: 1 }, { unique: true });

export const Analysis = mongoose.model('Analysis', analysisSchema);
