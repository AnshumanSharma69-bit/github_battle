const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // GitHub API cache, 10 minutes

// ─── Redis Client ─────────────────────────────────────────────────────────────
// Falls back to in-memory if REDIS_URL is not set (local dev)
let redisClient = null;
let usingRedis = false;

async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.warn('⚠️  REDIS_URL not set — falling back to in-memory storage');
    return;
  }
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('❌ Redis error:', err.message));
  await redisClient.connect();
  usingRedis = true;
  console.log('✅ Redis connected');
}

// ─── In-Memory Fallback Store ─────────────────────────────────────────────────
// Used when Redis is not available (local dev / no REDIS_URL)
const memUsers = new Map();
const memBattles = [];
const BATTLES_LIMIT = 100;

// ─── Storage Helpers ──────────────────────────────────────────────────────────
const USERS_KEY   = 'users';        // Redis hash: githubId → JSON
const BATTLES_KEY = 'battles';      // Redis list: JSON entries

async function storeSaveUser(user) {
  if (usingRedis) {
    await redisClient.hSet(USERS_KEY, user.githubId, JSON.stringify(user));
  } else {
    memUsers.set(user.githubId, user);
  }
}

async function storeGetUser(githubId) {
  if (usingRedis) {
    const raw = await redisClient.hGet(USERS_KEY, githubId);
    return raw ? JSON.parse(raw) : null;
  }
  return memUsers.get(githubId) || null;
}

async function storeSaveBattle(battle) {
  if (usingRedis) {
    await redisClient.lPush(BATTLES_KEY, JSON.stringify(battle));
    await redisClient.lTrim(BATTLES_KEY, 0, BATTLES_LIMIT - 1); // keep last 100
  } else {
    memBattles.unshift(battle);
    if (memBattles.length > BATTLES_LIMIT) memBattles.length = BATTLES_LIMIT;
  }
}

async function storeGetBattles(limit = 20, filterLogin = null) {
  let battles;
  if (usingRedis) {
    const raw = await redisClient.lRange(BATTLES_KEY, 0, BATTLES_LIMIT - 1);
    battles = raw.map(r => JSON.parse(r));
  } else {
    battles = memBattles;
  }
  if (filterLogin) battles = battles.filter(b => b.initiatedBy === filterLogin);
  return battles.slice(0, limit);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5500',
  credentials: true,
}));
app.use(express.json());

// Session store: Redis if available, otherwise default in-memory
function buildSession() {
  const base = {
    secret: process.env.SESSION_SECRET || 'github-battle-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    },
  };
  if (usingRedis) {
    base.store = new RedisStore({ client: redisClient, prefix: 'sess:' });
    console.log('🔒 Sessions stored in Redis');
  }
  return session(base);
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  skip: (req) => req.isAuthenticated(),
  message: { error: 'Rate limit exceeded. Login with GitHub for 5000 requests/hour!' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', guestLimiter);

// ─── Passport GitHub OAuth ────────────────────────────────────────────────────
passport.use(new GitHubStrategy({
  clientID:     process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL:  process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/github/callback',
  scope: ['read:user'],
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const existing = await storeGetUser(profile.id);
    const user = {
      githubId:    profile.id,
      login:       profile.username,
      name:        profile.displayName || profile.username,
      avatar:      profile.photos?.[0]?.value || '',
      accessToken,
      createdAt:   existing?.createdAt || new Date().toISOString(),
    };
    await storeSaveUser(user);
    if (!existing) console.log(`✅ New user: @${profile.username}`);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.githubId));
passport.deserializeUser(async (githubId, done) => {
  try {
    const user = await storeGetUser(githubId);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// ─── GitHub API Helper ────────────────────────────────────────────────────────
async function fetchGitHubUser(username, userToken = null) {
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

// ─── Bootstrap (Redis → session → passport → routes) ─────────────────────────
async function bootstrap() {
  await connectRedis();

  // Session must be set up AFTER Redis is connected so RedisStore has a client
  app.use(buildSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // ─── OAuth Routes ───────────────────────────────────────────────────────────
  app.get('/auth/github', passport.authenticate('github', { scope: ['read:user'] }));

  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: `${process.env.FRONTEND_URL}?auth=failed` }),
    (req, res) => {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5500'}?auth=success`);
    }
  );

  app.post('/auth/logout', (req, res) => {
    req.logout(err => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      res.json({ message: 'Logged out successfully' });
    });
  });

  app.get('/auth/me', (req, res) => {
    if (req.isAuthenticated()) {
      res.json({
        loggedIn: true,
        user: { login: req.user.login, name: req.user.name, avatar: req.user.avatar },
      });
    } else {
      res.json({ loggedIn: false, user: null });
    }
  });

  // ─── API Routes ─────────────────────────────────────────────────────────────

  // GET /api/user/:username
  app.get('/api/user/:username', async (req, res) => {
    const { username } = req.params;
    const cacheKey = `user:${username.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });
    try {
      const token = req.user?.accessToken || null;
      const data = await fetchGitHubUser(username, token);
      cache.set(cacheKey, data);
      res.json({ ...data, fromCache: false });
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
    }
  });

  // POST /api/battle
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
      await storeSaveBattle({
        p1Login: p1.login, p2Login: p2.login,
        p1Avatar: p1.avatar, p2Avatar: p2.avatar,
        p1Score: Math.round(p1.score), p2Score: Math.round(p2.score),
        winner,
        initiatedBy: req.user?.login || 'guest',
        createdAt: new Date().toISOString(),
      });
      res.json({ p1, p2, winner });
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
    }
  });

  // GET /api/battles — recent battles (public)
  app.get('/api/battles', async (req, res) => {
    try {
      const battles = await storeGetBattles(20);
      res.json({ battles });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/battles/mine — battles by logged-in user
  app.get('/api/battles/mine', requireAuth, async (req, res) => {
    try {
      const battles = await storeGetBattles(20, req.user.login);
      res.json({ battles });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cache/stats
  app.get('/api/cache/stats', (req, res) => res.json(cache.getStats()));

  // GET /api/health
  app.get('/api/health', async (req, res) => {
    let redisPing = false;
    if (usingRedis) {
      try { await redisClient.ping(); redisPing = true; } catch (_) {}
    }
    res.json({
      status: 'ok',
      storage: usingRedis ? 'redis' : 'in-memory',
      redis: usingRedis ? (redisPing ? 'connected' : 'error') : 'disabled',
      cacheKeys: cache.keys().length,
      uptime: Math.floor(process.uptime()) + 's',
      authEnabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
  });

  // ─── Start ───────────────────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔐 OAuth: ${process.env.GITHUB_CLIENT_ID ? 'enabled' : 'disabled (set GITHUB_CLIENT_ID)'}`);
    console.log(`💾 Storage: ${usingRedis ? 'Redis' : 'in-memory (set REDIS_URL for persistence)'}`);
  });
}

bootstrap().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});