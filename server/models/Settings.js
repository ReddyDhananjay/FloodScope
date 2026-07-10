import { mongoose } from '../db.js';

const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});

export const Settings = mongoose.model('Settings', settingsSchema);

/** Helper to get a setting value */
export async function getSetting(key) {
  const s = await Settings.findOne({ key });
  return s ? s.value : null;
}

/** Helper to set a setting value */
export async function setSetting(key, value) {
  return await Settings.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}
