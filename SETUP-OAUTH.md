# 🔐 Google OAuth Setup Guide

Google login with automatic 2-step verification (2FA).

## How 2FA works
When you use Google OAuth, Google handles everything:
1. User clicks "Sign in with Google"
2. Google shows their own login page (email → password → 2FA code)
3. Google redirects back to your app only after successful 2FA
4. **You don't implement 2FA yourself** — Google does it

## Setup Steps (10 minutes)

### Step 1: Configure OAuth Consent Screen
1. Go to **https://console.cloud.google.com/apis/credentials/consent**
2. Choose **"External"** → Create
3. Fill in:
   - App name: `FloodScope`
   - User support email: your email
   - Developer contact: your email
4. Save and Continue through Scopes (add `userinfo.email` and `userinfo.profile`)
5. Add yourself as a **Test User** (your Gmail address)

### Step 2: Create OAuth Client ID
1. Go to **https://console.cloud.google.com/apis/credentials**
2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
3. Application type: **Web application**
4. Name: `FloodScope Login`
5. **Authorized redirect URIs** — add BOTH:
   ```
   http://localhost:8000/auth/google/callback
   ```
   (and your production URL later, e.g. `https://your-app.onrender.com/auth/google/callback`)
6. Click **Create**
7. **Copy the Client ID and Client Secret**

### Step 3: Add to .env
Open your `.env` file and add:
```
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret-here
SESSION_SECRET=any-random-string-here
```

### Step 4: Store Google Maps API key in database
Run this command (replaces entering the key every time):
```bash
node scripts/set-key.js GOOGLE_MAPS_KEY AIzaSyCoIw8euYuGqqbHXWnOQCtPmAOvF9Q4MRg
```

### Step 5: Set up Earth Engine
```bash
pip install earthengine-api
```
Then get your service account key:
1. Go to **https://code.earthengine.google.com**
2. Click your profile → **"User settings"** → **"Service Account"**
3. Or go to Google Cloud Console → IAM → Service Accounts → Create
4. Download the JSON key file
5. Save it as `ee-key.json` in the `floodscope` folder

### Step 6: Restart the server
```bash
npm start
```

You should see:
```
✅ Server running:  http://localhost:8000
🔐 Login page:      http://localhost:8000/login
🟢 Google OAuth:    ENABLED (2FA handled by Google)
```

Now when you visit http://localhost:8000, you'll be redirected to the login page.
Click "Sign in with Google" → Google handles email/password/2FA → you're logged in!
