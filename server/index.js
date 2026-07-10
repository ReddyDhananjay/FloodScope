import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import { connectDB } from './db.js';
import { floodRouter } from './routes/flood.js';
import { importRouter } from './routes/import.js';
import { geeRouter, handleGeeAnalyze, handleGeePolygon, handleGeeSamplePoint, handleGeeRegionFrequency } from './routes/gee.js';
import { setupAuth } from './auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

console.log('\n======================================================');
console.log('  🌊 FloodScope - Flood Analysis Platform');
console.log('======================================================\n');

// Resolve MongoDB readiness FIRST — the session store below depends on it,
// and we need to know this before wiring up any auth-dependent middleware.
let mongoReady = false;
try {
  await connectDB();
  mongoReady = true;
} catch (err) {
  console.log('  ⚠️  Starting without MongoDB\n');
}
app.locals.mongoReady = mongoReady;

// ===== Trust proxy (needed for Render/cloud deployment) =====
app.set('trust proxy', 1);

// ===== Middleware =====
// If ALLOWED_ORIGINS is set (comma-separated), restrict credentialed requests
// to that list. Otherwise reflect the request origin (fine for a monolithic
// app where the frontend and API are served from the same origin).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

// Session for auth.
// Uses MongoDB as the session store (only once we've confirmed Mongo is
// actually reachable) so logins survive server restarts and redeploys —
// the default in-memory store is wiped every time the process restarts,
// which on hosts like Render (which spin the app down/up) means everyone
// gets logged out constantly. Falls back to the in-memory store if Mongo
// isn't available, so a bad/missing MONGODB_URI never crashes the server.
let sessionStore;
if (mongoReady) {
  try {
    sessionStore = MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'sessions',
      ttl: 24 * 60 * 60,
    });
    sessionStore.on('error', (e) => console.error('  ⚠️  Session store error:', e.message));
  } catch (e) {
    console.error('  ⚠️  Could not set up MongoDB session store, falling back to in-memory:', e.message);
    sessionStore = undefined;
  }
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'floodscope-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Static files — but NOT the main app HTML (that requires auth)
// HTML files bypass static and fall through to the catch-all route with requireAuth
const staticMiddleware = express.static(path.join(__dirname, '..', 'public'), { index: false });
app.use((req, res, next) => {
  // Allow login.html without auth; all other HTML files require auth
  if (req.path.match(/\.html$/i) && req.path !== '/login.html') {
    return next(); // Skip static -> catch-all route handles with auth
  }
  staticMiddleware(req, res, next);
});

// File upload config (for KML/KMZ)
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(kml|kmz)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only KML or KMZ files are allowed'));
    }
  },
});

// ===== Auth =====
const googleOAuthEnabled = setupAuth(app);

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  const authed = typeof req.isAuthenticated === 'function' ? req.isAuthenticated() : false;
  if (authed) return next();
  // Use originalUrl because req.path is relative when mounted via app.use()
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.redirect('/login');
}

// ===== Login page (before catch-all) =====
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ===== GEE Analyze — file upload (KML/KMZ) =====
app.post('/api/gee/analyze', requireAuth, upload.single('kml'), handleGeeAnalyze);

// ===== GEE Point Query — get REAL flood data at a single point =====
app.post('/api/gee/sample-point', requireAuth, handleGeeSamplePoint);

// ===== GEE Analyze — polygon drawn on map (no file needed) =====
app.post('/api/gee/analyze-polygon', requireAuth, handleGeePolygon);

// ===== GEE Region Frequency Scan — recurring flood points across a boundary over a date range =====
app.post('/api/gee/analyze-region-frequency', requireAuth, handleGeeRegionFrequency);

// ===== API Routes =====
app.use('/api/gee', requireAuth, geeRouter);
app.use('/api/flood', requireAuth, floodRouter);
app.use('/api/import', requireAuth, importRouter);

// ===== Settings: get/store API keys in database =====
app.get('/api/settings/maps-key', requireAuth, async (req, res) => {
  try {
    const { getSetting } = await import('./models/Settings.js');
    const key = await getSetting('GOOGLE_MAPS_KEY');
    res.json({ hasKey: !!key });
  } catch (e) {
    res.json({ hasKey: false });
  }
});

app.get('/api/settings/maps-key-value', requireAuth, async (req, res) => {
  try {
    const { getSetting } = await import('./models/Settings.js');
    const key = await getSetting('GOOGLE_MAPS_KEY');
    res.json({ key: key || '' });
  } catch (e) {
    res.json({ key: '' });
  }
});

app.post('/api/settings/maps-key', requireAuth, async (req, res) => {
  try {
    const { setSetting } = await import('./models/Settings.js');
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    await setSetting('GOOGLE_MAPS_KEY', key.trim());
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Health check (no auth required — needed for login page check) =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    authEnabled: true, // local email/password auth always available
    googleEnabled: googleOAuthEnabled,
    mongoReady: !!app.locals.mongoReady,
  });
});

// ===== Catch-all: serve app (with auth check) =====
app.get('*', requireAuth, (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'flood-explorer.html'));
});

// ===== Global Error Handler =====
// Catches multer errors, passport errors, and all unhandled exceptions
// Returns JSON instead of HTML stack traces
app.use((err, req, res, next) => {
  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
  }
  // Multer file type error
  if (err.message && err.message.includes('Only KML')) {
    return res.status(400).json({ error: err.message });
  }
  // Generic errors
  console.error('  ❌ Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ===== Start =====
async function start() {
  const fs = await import('fs');
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  app.listen(PORT, () => {
    console.log(`  ✅ Server running:  http://localhost:${PORT}`);
    console.log(`  🔐 Login page:      http://localhost:${PORT}/login`);
    console.log(`  🟢 Auth:            Email/Password ACTIVE`);
    if (googleOAuthEnabled) {
      console.log(`  🟢 Google OAuth:    ENABLED (2FA handled by Google)`);
    } else {
      console.log(`  ⚪ Google OAuth:    Not configured (set GOOGLE_CLIENT_ID/SECRET)`);
    }
    console.log(`\n  Press Ctrl+C to stop\n`);
  });
}

start();
