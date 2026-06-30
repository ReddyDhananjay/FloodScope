import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'crypto';
import { connectDB } from './db.js';
import { floodRouter } from './routes/flood.js';
import { analysisRouter } from './routes/analysis.js';
import { importRouter } from './routes/import.js';
import { geeRouter, handleGeeAnalyze, handleGeePolygon } from './routes/gee.js';
import { setupAuth } from './auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;
const isProduction = process.env.NODE_ENV === 'production';

// ===== Fail fast on missing/weak secrets in production =====
// Running with a default/guessable session secret in production lets an
// attacker forge session cookies. We refuse to boot rather than silently
// running insecurely.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (isProduction && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.error('  ❌ SESSION_SECRET is missing or too short for production.');
  console.error('     Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const effectiveSessionSecret = SESSION_SECRET || crypto.randomBytes(48).toString('hex');

// ===== Trust proxy (needed for Render/cloud deployment) =====
app.set('trust proxy', 1);

// ===== Security headers =====
app.use(helmet({
  contentSecurityPolicy: false, // app loads Google Maps/inline scripts; enable + tune if you lock down external scripts
  crossOriginEmbedderPolicy: false,
}));

// ===== CORS =====
// Only allow browsers from an explicitly configured origin to send credentials.
// `origin: true` (reflecting every caller) combined with `credentials: true`
// effectively disables the same-origin protection CORS is meant to provide.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow same-origin / non-browser requests (no Origin header), and
    // requests from explicitly allow-listed origins.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// Strip any keys starting with `$` or containing `.` from req.body/query/params
// to prevent MongoDB operator-injection attacks.
app.use(mongoSanitize());

// ===== Rate limiting =====
// Generic API limiter
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Stricter limiter on auth endpoints to slow down credential stuffing / brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
app.use('/auth/login', authLimiter);
app.use('/auth/signup', authLimiter);

// Session for auth
app.use(session({
  secret: effectiveSessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'floodscope.sid', // don't leak that this is an express-session app
  cookie: {
    httpOnly: true,
    // Behind a TLS-terminating proxy (Render/nginx) `trust proxy` lets
    // Express see the connection as secure, so we can safely require
    // secure cookies whenever we're in production.
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// (Static files are mounted further down, after auth is configured, so they
// can be gated by requireAuth — see below.)

// ===== File upload config (for KML/KMZ) =====
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.kml', '.kmz']);
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Validate by extension AND a basic mimetype allow-list. Neither is a
    // hard security boundary on its own, but together with the size limit
    // and the fact this route requires auth, this meaningfully narrows the
    // attack surface for arbitrary file upload.
    const allowedMimeTypes = new Set([
      'application/vnd.google-earth.kml+xml',
      'application/vnd.google-earth.kmz',
      'application/octet-stream',
      'text/xml',
      'application/xml',
    ]);
    if (ALLOWED_UPLOAD_EXTENSIONS.has(ext) && allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only KML or KMZ files allowed'));
    }
  },
});

// ===== Auth =====
const authReady = setupAuth(app);

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  const authed = typeof req.isAuthenticated === 'function' ? req.isAuthenticated() : false;
  if (authed) return next();
  // IMPORTANT: use req.originalUrl, not req.path. When this middleware is
  // mounted via `app.use('/api/flood', requireAuth, ...)`, Express strips
  // the mount prefix from req.path for everything mounted under it, so
  // req.path would be e.g. "/stats" instead of "/api/flood/stats" — which
  // made every protected API route silently fall through to an HTML
  // redirect instead of a 401 JSON response. req.originalUrl always holds
  // the full incoming path regardless of mount depth.
  if (req.originalUrl.startsWith('/api/') || req.originalUrl === '/ask') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.redirect('/login');
}

// ===== Login page (before static & catch-all; the only public HTML page) =====
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ===== Static files =====
// IMPORTANT: express.static serves files directly off disk *before* any
// downstream route handler runs. Mounting it unconditionally previously
// meant anyone could load the full app UI (flood-explorer.html) by
// requesting it directly — completely bypassing the login wall, since the
// requireAuth catch-all further down never even got a chance to run for
// requests static.js already answered. We now require auth before serving
// any static file; the one public page (login.html) is already handled by
// the explicit route above, so we exempt it here.
app.use((req, res, next) => {
  // /api/* and /auth/* routes manage their own auth individually (some are
  // intentionally public, e.g. /api/health, /auth/login). Only gate actual
  // page/static-asset requests here.
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path === '/ask') {
    return next();
  }
  if (req.path === '/login' || req.path === '/login.html') return next();
  return requireAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===== GEE Analyze — file upload (KML/KMZ) =====
app.post('/api/gee/analyze', requireAuth, upload.single('kml'), handleGeeAnalyze);

// ===== GEE Analyze — polygon drawn on map (no file needed) =====
app.post('/api/gee/analyze-polygon', requireAuth, express.json(), handleGeePolygon);

// ===== API Routes =====
app.use('/api/gee', requireAuth, geeRouter);
app.use('/api/flood', requireAuth, floodRouter);
app.use('/api/analysis', requireAuth, analysisRouter);
app.use('/api/import', requireAuth, importRouter);

// ===== Settings: get/store API keys in database =====
// NOTE: these endpoints expose stored third-party API keys (e.g. a Google
// Maps key) to any *authenticated* user. If you add more users than just
// yourself, consider restricting this further (e.g. an admin role) since
// any logged-in account can currently read these values.
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
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });
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
    authEnabled: authReady,
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

// ===== Central error handler =====
// Prevents stack traces / internal details from leaking to clients.
app.use((err, req, res, next) => {
  console.error('  ❌ Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: isProduction ? 'Something went wrong' : err.message,
  });
});

// ===== Start =====
async function start() {
  console.log('\n======================================================');
  console.log('  🌊 FloodScope - Flood Analysis Platform');
  console.log('======================================================\n');

  try {
    await connectDB();
    app.locals.mongoReady = true;
  } catch (err) {
    console.log('  ⚠️  Starting without MongoDB\n');
    app.locals.mongoReady = false;
  }

  const fs = await import('fs');
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  app.listen(PORT, () => {
    console.log(`  ✅ Server running:  http://localhost:${PORT}`);
    console.log(`  🔐 Login page:      http://localhost:${PORT}/login`);
    if (authReady) {
      console.log(`  🟢 Google OAuth:    ENABLED (2FA handled by Google)`);
    } else {
      console.log(`  ⚠️  Google OAuth:    Not configured (set GOOGLE_CLIENT_ID/SECRET)`);
      console.log(`     Email/password auth is still active — see SETUP-OAUTH.md`);
    }
    if (!isProduction) {
      console.log(`\n  ⚠️  NODE_ENV is not "production" — running in dev mode.`);
    }
    console.log(`\n  Press Ctrl+C to stop\n`);
  });
}

start();
