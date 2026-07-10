import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcryptjs';
import { User } from './models/User.js';

/**
 * Authentication setup.
 * - Local email/password auth is ALWAYS active.
 * - Google OAuth is activated only if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 * - Returns true if Google OAuth is configured, false otherwise.
 */
export function setupAuth(app) {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  // /auth/user — always registered (frontend checks this)
  app.get('/auth/user', (req, res) => {
    const authed = typeof req.isAuthenticated === 'function' ? req.isAuthenticated() : false;
    if (authed) {
      res.json({
        authenticated: true,
        user: { name: req.user.name, email: req.user.email, avatar: req.user.avatar },
      });
    } else {
      res.status(401).json({ authenticated: false });
    }
  });

  // ===== LOCAL (Email/Password) — always available =====
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
        if (!user) return done(null, false, { message: 'No account found with this email' });
        if (user.provider === 'google' && !user.password) {
          return done(null, false, { message: 'Please sign in with Google for this email' });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) return done(null, false, { message: 'Incorrect password' });
        user.lastLogin = new Date();
        await user.save();
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());

  // ===== Sign Up (register) =====
  app.post('/auth/signup', async (req, res, next) => {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email and password are required' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const hashed = await bcrypt.hash(password, 12);
      const user = await User.create({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password: hashed,
        provider: 'local',
      });

      req.login(user, (err) => {
        if (err) return next(err);
        res.json({ success: true, user: { name: user.name, email: user.email } });
      });
    } catch (err) {
      next(err);
    }
  });

  // ===== Sign In (email/password) =====
  app.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
      req.login(user, (err) => {
        if (err) return next(err);
        res.json({ success: true, user: { name: user.name, email: user.email } });
      });
    })(req, res, next);
  });

  // ===== Google OAuth (only if configured) =====
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback',
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
          const email = profile.emails?.[0]?.value;
          if (email) {
            user = await User.findOne({ email });
            if (user) {
              user.googleId = profile.id;
              user.provider = 'google';
            }
          }
          if (!user) {
            user = await User.create({
              googleId: profile.id,
              name: profile.displayName,
              email: email || `google-${profile.id}@floodscope.local`,
              avatar: profile.photos?.[0]?.value,
              provider: 'google',
            });
          }
        }
        user.lastLogin = new Date();
        await user.save();
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }));

    app.get('/auth/google', passport.authenticate('google', {
      scope: ['profile', 'email'],
      prompt: 'select_account',
    }));
    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/login?error=google_failed' }),
      (req, res) => res.redirect('/')
    );
  } else {
    console.log('  ⚪ Google OAuth not configured. Email/password auth is active.');
  }

  // ===== Logout =====
  app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login');
      });
    });
  });

  return !!GOOGLE_CLIENT_ID && !!GOOGLE_CLIENT_SECRET;
}
