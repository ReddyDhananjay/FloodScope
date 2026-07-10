import { mongoose } from '../db.js';

const userSchema = new mongoose.Schema({
  // For Google OAuth users
  googleId: { type: String, unique: true, sparse: true, index: true },

  // For email/password users
  email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
  password: { type: String, select: false }, // hashed, not selected by default

  // Common
  name: { type: String, required: true },
  avatar: { type: String },
  provider: { type: String, enum: ['google', 'local'], default: 'local' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },
});

export const User = mongoose.model('User', userSchema);
