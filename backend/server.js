const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // cache 10 minutes

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5500',
  credentials: true, // required for session cookies
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'github-battle-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));
app.use(passport.initialize());
app.use(passport.session());

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
// Logged-in users get 5000 req/hour (GitHub OAuth), guests get 60/hour
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  skip: (req) => req.isAuthenticated(), // skip for logged-in users
  message: { error: 'Rate limit exceeded. Login with GitHub for 5000 requests/hour!' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', guestLimiter);

// ─── MongoDB Schemas ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  githubId:   { type: String, required: true, unique: true },
  login:      { type: String, required: true },
  name:       { type: String },
  avatar:     { type: String },
  accessToken:{ type: String }, // GitHub OAuth token for API calls
  createdAt:  { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const battleSchema = new mongoose.Schema({
  p1Login:    { type: String, required: true },
  p2Login:    { type: String, required: true },
  p1Avatar:   { type: String },
  p2Avatar:   { type: String },
  p1Score:    { type: Number },
  p2Score:    { type: Number },
  winner:     { type: String, enum: ['p1', 'p2'] },
  initiatedBy:{ type: String }, // GitHub login of user who started the battle
  createdAt:  { type: Date, default: Date.now },
});
const Battle = mongoose.model('Battle', battleSchema);

// ─── MongoDB Connection ───────────────────────────────────────────────────────
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));
} else {
  console.warn('⚠️  MONGO_URI not set — DB features disabled');
}

// ─── Passport GitHub OAuth Strategy ──────────────────────────────────────────
passport.use(new GitHubStrategy({
  clientID:     process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL:  process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/github/callback',
  scope: ['read:user'], // only need to read user info
},
async (accessToken, refreshToken, profile, done) => {
  try {
    // Find or create user in DB
    let user = await User.findOne({ githubId: profile.id });
    if (!user) {
      user = await User.create({
        githubId:    profile.id,
        login:       profile.username,
        name:        profile.displayName || profile.username,
        avatar:      profile.photos?.[0]?.value || '',
        accessToken,
      });
      console.log(`✅ New user: @${profile.username}`);
    } else {
      // Update token on every login
      user.accessToken = accessToken;
      await user.save();
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// ─── GitHub API Helper ────────────────────────────────────────────────────────
async function fetchGitHubUser(username, userToken = null) {
  // Priority: logged-in user's OAuth token > server token > no token
  const token = userToken || process.env.GITHUB_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  const [userRes, reposRes] = await Promise.all([
    fetch(`https://api.github.com/users/${username}`, { headers }),
    fetch(`https://api.github.com/users/${username}/repos?per_page=100&sort=stars`, { headers }),
  ]);

  if (!userRes.ok) {
    const status = userRes.status;
    if (status === 404) throw new Error(`User "${username}" not found`);
    if (status === 403) throw new Error('GitHub API rate limit exceeded. Login with GitHub for higher limits!');
    throw new Error(`GitHub API error (${status})`);
  }

  const [user, repos] = await Promise.all([userRes.json(), reposRes.json()]);
  const all = Array.isArray(repos) ? repos : [];

  const stars = all.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const forks = all.reduce((s, r) => s + (r.forks_count || 0), 0);

  const langMap = {};
  all.forEach(r => { if (r.language) langMap[r.language] = (langMap[r.language] || 0) + 1; });
  const sortedLangs = Object.entries(langMap).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const totalLang = sortedLangs.reduce((s, [, v]) => s + v, 0);
  const languages = sortedLangs.map(([k, v]) => ({ name: k, pct: Math.round(v / totalLang * 100) }));

  const topRepos = all
    .filter(r => !r.fork)
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, 4)
    .map(r => ({
      name: r.name, desc: r.description,
      stars: r.stargazers_count || 0, forks: r.forks_count || 0,
      lang: r.language, url: r.html_url, updated: r.pushed_at,
    }));

  const created = new Date(user.created_at);
  const accountAge = ((new Date() - created) / (1000 * 60 * 60 * 24 * 365)).toFixed(1);
  const avgStars = all.length ? Math.round(stars / all.length) : 0;
  const avgForks = all.length ? Math.round(forks / all.length) : 0;
  const ratio = user.following ? +(user.followers / user.following).toFixed(2) : user.followers;
  const score = user.followers * 3 + user.public_repos * 2 + stars * 4 + forks * 2 + parseFloat(accountAge) * 5;

  return {
    login: user.login, name: user.name || user.login, avatar: user.avatar_url,
    bio: user.bio || '', location: user.location || '', company: user.company || '',
    blog: user.blog || '', followers: user.followers, following: user.following,
    repos: user.public_repos, stars, forks, languages, topRepos, score,
    url: user.html_url, joinYear: created.getFullYear(), accountAge, avgStars, avgForks, ratio,
  };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required' });
}

// ─── OAuth Routes ─────────────────────────────────────────────────────────────

// Step 1: Redirect to GitHub
app.get('/auth/github', passport.authenticate('github', { scope: ['read:user'] }));

// Step 2: GitHub redirects back here
app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: `${process.env.FRONTEND_URL}?auth=failed` }),
  (req, res) => {
    // Redirect back to frontend with success
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5500'}?auth=success`);
  }
);

// Logout
app.post('/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ message: 'Logged out successfully' });
  });
});

// GET /auth/me — get current logged-in user
app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      loggedIn: true,
      user: {
        login:  req.user.login,
        name:   req.user.name,
        avatar: req.user.avatar,
      },
    });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/user/:username — fetch GitHub user (with cache)
app.get('/api/user/:username', async (req, res) => {
  const { username } = req.params;
  const cacheKey = `user:${username.toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Use logged-in user's token for higher rate limits
    const token = req.user?.accessToken || null;
    const data = await fetchGitHubUser(username, token);
    cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/battle — battle two users & save to DB
app.post('/api/battle', async (req, res) => {
  const { username1, username2 } = req.body;

  if (!username1 || !username2)
    return res.status(400).json({ error: 'Both usernames are required' });
  if (username1.toLowerCase() === username2.toLowerCase())
    return res.status(400).json({ error: 'Enter two different usernames' });

  try {
    const token = req.user?.accessToken || null;

    const [p1, p2] = await Promise.all([
      cache.get(`user:${username1.toLowerCase()}`) || fetchGitHubUser(username1, token),
      cache.get(`user:${username2.toLowerCase()}`) || fetchGitHubUser(username2, token),
    ]);

    cache.set(`user:${username1.toLowerCase()}`, p1);
    cache.set(`user:${username2.toLowerCase()}`, p2);

    const winner = p1.score >= p2.score ? 'p1' : 'p2';

    if (mongoose.connection.readyState === 1) {
      await Battle.create({
        p1Login: p1.login, p2Login: p2.login,
        p1Avatar: p1.avatar, p2Avatar: p2.avatar,
        p1Score: Math.round(p1.score), p2Score: Math.round(p2.score),
        winner,
        initiatedBy: req.user?.login || 'guest',
      });
    }

    res.json({ p1, p2, winner });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// GET /api/battles — recent battles (public)
app.get('/api/battles', async (req, res) => {
  if (mongoose.connection.readyState !== 1)
    return res.json({ battles: [], message: 'Database not connected' });
  try {
    const battles = await Battle.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .select('p1Login p2Login p1Avatar p2Avatar winner initiatedBy createdAt');
    res.json({ battles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/battles/mine — battles by the logged-in user
app.get('/api/battles/mine', requireAuth, async (req, res) => {
  try {
    const battles = await Battle.find({ initiatedBy: req.user.login })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('p1Login p2Login p1Avatar p2Avatar winner createdAt');
    res.json({ battles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cache/stats
app.get('/api/cache/stats', (req, res) => res.json(cache.getStats()));

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    cacheKeys: cache.keys().length,
    uptime: Math.floor(process.uptime()) + 's',
    authEnabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔐 OAuth: ${process.env.GITHUB_CLIENT_ID ? 'enabled' : 'disabled (set GITHUB_CLIENT_ID)'}`);
});
