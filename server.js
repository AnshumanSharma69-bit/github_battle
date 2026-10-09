// GitHub Battle backend v3 — OAuth, cached GitHub fetches, rate limiting, validation
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const {
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_TOKEN,
  SESSION_SECRET, NODE_ENV,
  FRONTEND_URL = 'http://localhost:5500',
  BACKEND_URL = 'http://localhost:3000',
  PORT = 3000,
} = process.env;
const prod = NODE_ENV === 'production';
if (prod && !SESSION_SECRET) throw new Error('SESSION_SECRET is required in production');

const app = express();
app.set('trust proxy', 1);
const allowed = FRONTEND_URL.split(',').map(s => s.trim());
app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.includes(o)), credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use(session({
  secret: SESSION_SECRET || 'dev-only-secret', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: prod, sameSite: prod ? 'none' : 'lax', maxAge: 7 * 864e5 },
}));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down a little.' } }));

// ── GitHub fetch (native fetch, Node 18+) with cache ─────────────────────────
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function gh(path, token) {
  const key = `${token ? 'auth' : 'anon'}:${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = token || GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'github-battle-app',
      ...(t && { Authorization: `Bearer ${t}` }) },
  });
  if (r.status === 404) throw new HttpError(404, 'GitHub user not found');
  if (r.status === 403 || r.status === 429)
    throw new HttpError(429, 'GitHub rate limit hit. Log in with GitHub for higher limits.');
  if (!r.ok) throw new HttpError(502, `GitHub API error (${r.status})`);
  const body = await r.json();
  cache.set(key, body);
  return body;
}

const USER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const validUser = u => typeof u === 'string' && USER_RE.test(u.trim());

async function buildUser(username, token) {
  const profile = await gh(`/users/${username}`, token);
  // Fetch up to 300 repos (3 pages in parallel); ignore forks so stats reflect original work
  const pages = Math.min(3, Math.ceil((profile.public_repos || 0) / 100));
  const chunks = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      gh(`/users/${username}/repos?per_page=100&page=${i + 1}&sort=pushed`, token).catch(() => [])));
  const all = chunks.flat();
  const repos = all.filter(r => !r.fork);

  const sum = k => repos.reduce((s, r) => s + (r[k] || 0), 0);
  const stars = sum('stargazers_count'), forks = sum('forks_count');
  const topRepos = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 3)
    .map(r => ({ name: r.name, desc: r.description || '', stars: r.stargazers_count, forks: r.forks_count,
      lang: r.language, url: r.html_url, updated: r.pushed_at }));

  const lc = {};
  repos.forEach(r => r.language && (lc[r.language] = (lc[r.language] || 0) + 1));
  const lt = Object.values(lc).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(lc).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, n]) => ({ name, pct: Math.round(n / lt * 100) }));

  const recent = all.filter(r => Date.now() - new Date(r.pushed_at) < 90 * 864e5).length;
  const repoCount = profile.public_repos || 0, followers = profile.followers || 0;
  const accountAge = +((Date.now() - new Date(profile.created_at)) / (365.25 * 864e5)).toFixed(1);
  // Log-damped so one viral repo can't completely drown everything else
  const score = Math.round(
    Math.log10(stars + 1) * 400 + Math.log10(followers + 1) * 350 + Math.log10(forks + 1) * 150 +
    Math.min(repoCount, 100) * 3 + Math.min(accountAge, 15) * 12 + recent * 15 + languages.length * 10);

  return {
    login: profile.login, name: profile.name || profile.login, avatar: profile.avatar_url,
    bio: profile.bio || '', location: profile.location || '', company: profile.company || '',
    blog: profile.blog || '', url: profile.html_url, repos: repoCount, stars, forks, followers,
    following: profile.following || 0, accountAge, joinYear: new Date(profile.created_at).getFullYear(),
    recentRepos: recent, score, topRepos, languages,
  };
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (!(e instanceof HttpError)) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, cached: cache.keys().length }));

app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) return res.status(500).json({ error: 'OAuth not configured' });
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect('https://github.com/login/oauth/authorize?' + new URLSearchParams({
    client_id: GITHUB_CLIENT_ID, redirect_uri: `${BACKEND_URL}/auth/github/callback`, scope: 'read:user', state }));
});

app.get('/auth/github/callback', async (req, res) => {
  const { code, state } = req.query;
  const fail = () => res.redirect(`${allowed[0]}?auth=failed`);
  if (!code || !state || state !== req.session.oauthState) return fail(); // CSRF protection
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }) });
    const { access_token } = await tr.json();
    if (!access_token) return fail();
    const u = await (await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'github-battle-app' } })).json();
    req.session.user = { login: u.login, name: u.name || u.login, avatar: u.avatar_url };
    req.session.token = access_token;
    delete req.session.oauthState;
    res.redirect(`${allowed[0]}?auth=success`);
  } catch (e) { console.error('OAuth:', e.message); fail(); }
});

app.get('/auth/me', (req, res) => res.json({ loggedIn: !!req.session.user, user: req.session.user || null }));
app.post('/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); }));

app.get('/api/profile/:username', wrap(async (req, res) => {
  if (!validUser(req.params.username)) throw new HttpError(400, 'Invalid GitHub username');
  res.json(await buildUser(req.params.username.trim(), req.session.token));
}));

app.post('/api/battle', wrap(async (req, res) => {
  const { username1: a, username2: b } = req.body || {};
  if (!validUser(a) || !validUser(b)) throw new HttpError(400, 'Enter two valid GitHub usernames');
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) throw new HttpError(400, 'Pick two different players');
  const [p1, p2] = await Promise.all([buildUser(a.trim(), req.session.token), buildUser(b.trim(), req.session.token)]);
  res.json({ p1, p2, winner: p1.score >= p2.score ? 'p1' : 'p2' });
}));

app.listen(PORT, () => console.log(`⚔️  GitHub Battle API on :${PORT} (OAuth ${GITHUB_CLIENT_ID ? 'on' : 'off'})`));
