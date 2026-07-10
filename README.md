# 🌊 FloodScope — Flood Analysis Platform

Vijayawada flood data analysis with an interactive map, AI cause analysis, Earth Engine satellite flood detection, and a MongoDB-backed account system.

## Tech stack
- **Frontend**: HTML/CSS/JS + Leaflet maps (OpenStreetMap)
- **Backend**: Node.js + Express, hardened with Helmet, rate limiting, and Mongo-injection sanitization (see [SECURITY.md](../SECURITY.md))
- **Database**: MongoDB (Atlas cloud or local)
- **Geospatial**: Python + Google Earth Engine
- **AI**: DeepSeek via NVIDIA API (optional)

## Project structure
```
floodscope/
├── server/
│   ├── index.js          # Express server (entry point, security middleware)
│   ├── auth.js           # Passport auth: email/password + Google OAuth
│   ├── db.js              # MongoDB connection
│   ├── gee.py             # Earth Engine flood detection script
│   ├── models/
│   │   ├── User.js
│   │   ├── FloodPoint.js  # Flood data points schema
│   │   ├── Analysis.js    # AI analysis results schema
│   │   ├── Dataset.js     # Dataset metadata schema
│   │   └── Settings.js    # Runtime-configurable keys (e.g. Maps API key)
│   └── routes/
│       ├── flood.js       # Flood data API endpoints
│       ├── analysis.js    # Cause analysis endpoints
│       ├── import.js      # CSV import endpoints
│       └── gee.js         # Earth Engine analysis endpoints
├── public/
│   ├── flood-explorer.html  # Frontend app
│   ├── login.html           # Login / signup page
│   └── index.html           # Redirect
├── scripts/
│   ├── import-csv.js      # CLI CSV importer
│   └── set-key.js         # CLI tool to store API keys in the DB
├── package.json
├── .env.example
└── render.yaml             # Cloud deployment config (Render.com)
```

## API endpoints

All `/api/*` endpoints (except `/api/health`) require an authenticated session.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check (public) |
| GET | `/api/import/status` | Check if data is loaded |
| GET | `/api/flood/stats` | Dataset statistics |
| GET | `/api/flood/heatmap?event=-1` | Heatmap data |
| GET | `/api/flood/nearest?lat=X&lng=Y` | Nearest point to coordinates |
| GET | `/api/flood/hotspots?limit=12` | Top flood hotspots |
| GET | `/api/flood/point/:fid` | Single point by ID |
| GET | `/api/analysis/:lat/:lng` | Flood cause analysis |
| POST | `/api/analysis/:lat/:lng/ai` | Save AI analysis |
| POST | `/api/import/csv` | Import CSV to database |
| POST | `/api/gee/analyze` | Earth Engine analysis from uploaded KML/KMZ |
| POST | `/api/gee/analyze-polygon` | Earth Engine analysis from a drawn polygon |
| POST | `/auth/signup` | Create account (rate-limited) |
| POST | `/auth/login` | Email/password login (rate-limited) |
| GET | `/auth/google` | Start Google OAuth flow |
| POST | `/ask` | AI proxy (NVIDIA/DeepSeek) |

## Setup (5 minutes)

### 1. Install dependencies
```bash
cd floodscope
npm install
```

### 2. Set up MongoDB Atlas (free cloud database)
1. Go to https://www.mongodb.com/atlas → sign up free
2. Create a free cluster (M0)
3. Under "Database Access" → add a user (remember the password)
4. Under "Network Access" → allow access from your deployment's IP (avoid `0.0.0.0/0` in production if you can scope it down)
5. Click "Connect" → "Drivers" → copy the connection string

### 3. Configure environment variables
```bash
cp .env.example .env
```
Edit `.env`:
- `MONGODB_URI` — your Atlas connection string
- `SESSION_SECRET` — a long random string (**required** in production; the server refuses to start without one). Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional, see [SETUP-OAUTH.md](SETUP-OAUTH.md)
- `EE_SERVICE_ACCOUNT_KEY` — path to your Earth Engine service-account JSON key, kept **outside** this repo (see [SECURITY.md](../SECURITY.md))
- `ALLOWED_ORIGINS` — only needed if your frontend is hosted on a different origin from the API

### 4. Import your flood data
```bash
node scripts/import-csv.js path/to/your-flood-data.csv
```

### 5. Start the server
```bash
npm start          # production
npm run dev         # auto-restart on changes
```

### 6. Open in browser
```
http://localhost:8000
```
You'll be redirected to `/login` — sign up for a local account or use Google OAuth if configured.

## Deploy to Render.com (free tier)
1. Push this repo to GitHub (see the root [README](../README.md) and [SECURITY.md](../SECURITY.md) first — make sure no secrets are committed)
2. Go to https://render.com → New → Web Service → connect your repo, root directory `floodscope`
3. Set environment variables in the Render dashboard: `MONGODB_URI`, `SESSION_SECRET`, `NODE_ENV=production`, and optionally `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`ALLOWED_ORIGINS`
4. Deploy — you'll get a live URL like `https://floodscope.onrender.com`

## Database collections

### `floodpoints`
Flood data points: `fid`, `lat`, `lng`, `freq` (times flooded), `flags` (per-event 0/1), `events` (event column names).

### `analyses`
AI & geographic analysis cache: `lat`, `lng`, `geo` (distance to nearest river/landmark), `causes` (auto-generated cause cards), `aiAnalysis` (AI text analysis, if generated).

### `datasets`
Dataset metadata: total points, flooded counts, event list, date ranges.

### `users`
Account records (email/password — bcrypt hashed — or Google OAuth identity).

### `settings`
Runtime-configurable keys (e.g. a Google Maps API key set via the UI/CLI instead of an env var).
