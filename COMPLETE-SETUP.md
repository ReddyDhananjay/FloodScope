# 🚀 FloodScope — Complete Setup Guide

Follow these steps IN ORDER. Each step is needed. Take your time.

---

## STEP 1: Find your downloaded folder (30 seconds)

1. Open **Finder** → **Downloads**
2. Find the downloaded workspace ZIP and **double-click to unzip** it
3. Open Terminal and run this to find the exact path:

```bash
find ~/Downloads -name "package.json" -path "*floodscope*" 2>/dev/null
```

It will print something like:
```
/Users/rdhananjay/Downloads/workspace-xxxxx/floodscope/package.json
```

The folder path is everything BEFORE `package.json`. Copy it.

---

## STEP 2: Open the folder in Terminal (30 seconds)

```bash
cd "PASTE_YOUR_PATH_HERE"
```

Example:
```bash
cd ~/Downloads/workspace-019ecee3-33af-74d2-9c53-8264a828984e/floodscope
```

**Verify you're in the right place:**
```bash
ls
```

You should see: `package.json`, `server/`, `public/`, `scripts/`

---

## STEP 3: Remove macOS security lock (30 seconds)

macOS blocks downloaded files. Run this ONCE:

```bash
xattr -dr com.apple.quarantine . 2>/dev/null; echo "Done"
```

---

## STEP 4: Install Node.js packages (2 minutes)

```bash
npm install
```

Wait until you see: `added XX packages`

---

## STEP 5: Set up MongoDB Atlas (FREE database) — 10 minutes

### 5.1 Create account
1. Go to: **https://www.mongodb.com/cloud/atlas/register**
2. Sign up with your email

### 5.2 Create cluster
1. Choose **M0 Free** plan
2. Provider: **AWS**, Region: **ap-south-1 (Mumbai)**
3. Click **Create Cluster**
4. Wait 2-3 minutes (it says "Creating your cluster")

### 5.3 Create database user
1. Left sidebar → **Database Access** (under Security)
2. Click **Add New Database User**
3. Authentication method: **Password**
4. Username: `floodscope`
5. Password: `Flood@2026` (write this down!)
6. Privileges: **Read and write to any database**
7. Click **Add User**

### 5.4 Allow network access
1. Left sidebar → **Network Access** (under Security)
2. Click **Add IP Address**
3. Click **ALLOW ACCESS FROM ANYWHERE** (adds 0.0.0.0/0)
4. Click **Confirm**
5. Wait until status shows **Active**

### 5.5 Get connection string
1. Left sidebar → **Database**
2. Click the green **Connect** button
3. Select **Drivers**
4. Select **Node.js** from dropdown
5. Copy the connection string — it looks like:
   ```
   mongodb+srv://floodscope:<password>@cluster0.xxxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. **Replace `<password>` with your actual password** (Flood@2026)
7. **Add `/floodscope` before the `?`** so it looks like:
   ```
   mongodb+srv://floodscope:Flood@2026@cluster0.xxxxxx.mongodb.net/floodscope?retryWrites=true&w=majority
   ```

**Copy this final string — you need it for Step 7.**

---

## STEP 6: Set up Google OAuth (Login) — 10 minutes

### 6.1 Go to Google Cloud Console
1. Open: **https://console.cloud.google.com/**
2. Sign in with your Gmail

### 6.2 Create project
1. Click project dropdown (top bar) → **NEW PROJECT**
2. Name: `floodscope`
3. Click **CREATE**
4. Select it from the dropdown

### 6.3 Configure consent screen
1. Go to: **APIs & Services → OAuth consent screen**
   (or: https://console.cloud.google.com/apis/credentials/consent)
2. User type: **External** → Create
3. Fill in:
   - App name: `FloodScope`
   - User support email: your email
   - Developer contact: your email
4. Click **SAVE AND CONTINUE** through all screens
5. On "Test users" page → **ADD USERS** → add your Gmail → Save

### 6.4 Create OAuth Client ID
1. Go to: **APIs & Services → Credentials**
   (or: https://console.cloud.google.com/apis/credentials)
2. Click **+ CREATE CREDENTIALS → OAuth client ID**
3. Application type: **Web application**
4. Name: `FloodScope Login`
5. **Authorized redirect URIs** — click ADD URI and paste:
   ```
   http://localhost:8000/auth/google/callback
   ```
6. Click **CREATE**
7. **Copy the Client ID and Client Secret** (shown in popup)

---

## STEP 7: Create .env file (2 minutes)

In Terminal (still in the floodscope folder), run:

```bash
cp .env.example .env
```

Then open it in a text editor:
```bash
nano .env
```

Replace the content with YOUR values (use arrow keys to edit, then Ctrl+O, Enter, Ctrl+X to save):

```
MONGODB_URI=mongodb+srv://floodscope:Flood@2026@cluster0.xxxxxx.mongodb.net/floodscope?retryWrites=true&w=majority
PORT=8000
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_SECRET_HERE
SESSION_SECRET=floodscope-random-2026
EE_SERVICE_ACCOUNT_KEY=ee-key.json
```

**Replace:**
- `Flood@2026@cluster0.xxxxxx` → your actual MongoDB details from Step 5
- `YOUR_CLIENT_ID_HERE` → from Step 6
- `YOUR_SECRET_HERE` → from Step 6

---

## STEP 8: Set up Earth Engine (Satellite data) — 5 minutes

### 8.1 Install Python package
```bash
pip3 install earthengine-api
```

If that fails, try:
```bash
pip install earthengine-api
```

### 8.2 Authenticate (opens browser)
```bash
earthengine authenticate
```

This opens a browser window. Sign in with the Google account that has Earth Engine access. Click the link it shows, copy the token, paste back in Terminal.

### 8.3 Verify it works
```bash
python3 -c "import ee; ee.Initialize(); print('Earth Engine OK')"
```

If you see `Earth Engine OK` — you're done. If you see an error, run `earthengine authenticate` again.

---

## STEP 9: Store the Google Maps API key in database (1 minute)

```bash
node scripts/set-key.js GOOGLE_MAPS_KEY AIzaSyCoIw8euYuGqqbHXWnOQCtPmAOvF9Q4MRg
```

You should see:
```
✅ Saved "GOOGLE_MAPS_KEY" to database
```

---

## STEP 10: Import your flood data (optional — 1 minute)

If you want to load the flood CSV into the database:

```bash
node scripts/import-csv.js ~/Downloads/FLOODS2017TO2025.csv
```

Wait ~30 seconds. You should see:
```
✅ Import complete
  Total points:  143,416
```

---

## STEP 11: Start the server (10 seconds)

```bash
npm start
```

You should see:
```
======================================================
  🌊 FloodScope - Flood Analysis Platform
======================================================

  ✅ MongoDB connected
  ✅ Server running:  http://localhost:8000
  🔐 Login page:      http://localhost:8000/login
  🟢 Google OAuth:    ENABLED (2FA handled by Google)
```

**Keep this Terminal window open!** Do not close it.

---

## STEP 12: Open in browser 🎉

Open **http://localhost:8000** in Chrome/Safari/Firefox

1. You'll see the **login page**
2. Click **"Sign in with Google"**
3. Sign in with your Gmail (2FA if enabled)
4. You're in! 🎉

### To use it:
- **Upload CSV** → click "Load CSV" → select your file
- **Upload KML** → click the upload box → select area file
- **Pick date range** → select start and end dates
- **Run Analysis** → click the green button → see floods on map
- **Click any point** → Street View loads on the right

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: node` | Install Node.js from https://nodejs.org |
| `command not found: python3` | Install Python from https://python.org |
| MongoDB connection failed | Check password in .env, check Network Access is 0.0.0.0/0 |
| `redirect_uri_mismatch` | Add `http://localhost:8000/auth/google/callback` to OAuth redirect URIs |
| `No module named 'ee'` | Run `pip3 install earthengine-api` again |
| Login page says "dev mode" | GOOGLE_CLIENT_ID not set in .env — redo Step 7 |
| Port 8000 in use | Change PORT in .env to 8080 |
| Operation not permitted | Run `xattr -dr com.apple.quarantine .` again |

---

## ✅ Quick Start (if you already did all setup)

Just run:
```bash
cd ~/Downloads/workspace-xxxxx/floodscope
npm start
```
Open: http://localhost:8000
