// ── GitHub Battle Backend ─────────────────────────────────────────────────────
// Express server handling GitHub OAuth + /api/battle endpoint
// ──────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  SESSION_SECRET = 'change-me-in-production',
  FRONTEND_URL = 'http://localhost:5500',  // your frontend origin
  BACKEND_URL  = `http://localhost:${PORT}`,
} = process.env;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // true behind HTTPS in prod
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
  },
}));

// ── Simple HTTPS helper (no extra deps) ───────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'github-battle-app', ...headers },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, postData, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(postData);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'github-battle-app',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GitHub API helpers ────────────────────────────────────────────────────────
function ghGet(path, token = null) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return httpsGet(`https://api.github.com${path}`, headers);
}

// ── Rate-limit aware fetch with token fallback ────────────────────────────────
async function ghFetch(path, sessionToken = null) {
  const token = sessionToken || process.env.GITHUB_TOKEN || null;
  const res = await ghGet(path, token);
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API rate limit exceeded. Please log in with GitHub to get higher limits.');
  }
  if (res.status === 404) throw new Error('GitHub user not found');
  if (res.status >= 400) throw new Error(`GitHub API error: ${res.body?.message || res.status}`);
  return res.body;
}

// ── Process GitHub user data into battle payload ──────────────────────────────
async function buildUserData(username, token) {
  // Fetch profile
  const profile = await ghFetch(`/users/${username}`, token);

  // Fetch repos (up to 100, sorted by stars)
  let repos = [];
  try {
    repos = await ghFetch(`/users/${username}/repos?per_page=100&sort=pushed`, token);
    if (!Array.isArray(repos)) repos = [];
  } catch { /* ignore */ }

  // Aggregate stars & forks
  const totalStars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const totalForks = repos.reduce((s, r) => s + (r.forks_count || 0), 0);

  // Top 3 repos by stars
  const topRepos = [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 3)
    .map(r => ({
      name: r.name,
      desc: r.description || '',
      stars: r.stargazers_count || 0,
      forks: r.forks_count || 0,
      lang: r.language || null,
      url: r.html_url,
      updated: r.pushed_at,
    }));

  // Language distribution
  const langCounts = {};
  repos.forEach(r => {
    if (r.language) langCounts[r.language] = (langCounts[r.language] || 0) + 1;
  });
  const langTotal = Object.values(langCounts).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, pct: Math.round(count / langTotal * 100) }));

  // Derived stats
  const repoCount = profile.public_repos || 0;
  const followers = profile.followers || 0;
  const following = profile.following || 0;
  const ratio = following > 0 ? parseFloat((followers / following).toFixed(2)) : followers;
  const avgStars = repoCount > 0 ? parseFloat((totalStars / repoCount).toFixed(1)) : 0;
  const avgForks = repoCount > 0 ? parseFloat((totalForks / repoCount).toFixed(1)) : 0;
  const joinYear = new Date(profile.created_at).getFullYear();
  const accountAge = parseFloat(((Date.now() - new Date(profile.created_at)) / (365.25 * 24 * 3600 * 1000)).toFixed(1));

  // Power score formula (mirrors frontend expectation)
  const score =
    totalStars * 4 +
    followers * 3 +
    repoCount * 2 +
    totalForks * 2 +
    accountAge * 10 +
    avgStars * 5;

  return {
    login: profile.login,
    name: profile.name || profile.login,
    avatar: profile.avatar_url,
    bio: profile.bio || '',
    location: profile.location || '',
    company: profile.company || '',
    blog: profile.blog || '',
    url: profile.html_url,
    repos: repoCount,
    stars: totalStars,
    forks: totalForks,
    followers,
    following,
    ratio,
    avgStars,
    avgForks,
    joinYear,
    accountAge,
    score,
    topRepos,
    languages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── GitHub OAuth – Step 1: redirect to GitHub ─────────────────────────────────
app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
  }
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/auth/github/callback`,
    scope: 'read:user',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GitHub OAuth – Step 2: callback ──────────────────────────────────────────
app.get('/auth/github/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?auth=failed`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await httpsPost(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BACKEND_URL}/auth/github/callback`,
      }
    );

    const accessToken = tokenRes.body?.access_token;
    if (!accessToken) throw new Error('No access token received');

    // Get user info
    const userRes = await ghGet('/user', accessToken);
    const ghUser = userRes.body;

    // Store in session
    req.session.user = {
      login: ghUser.login,
      name: ghUser.name || ghUser.login,
      avatar: ghUser.avatar_url,
    };
    req.session.token = accessToken;

    res.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect(`${FRONTEND_URL}?auth=failed`);
  }
});

// ── Auth: get current user ─────────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (req.session?.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

// ── Auth: logout ──────────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ── Battle endpoint ───────────────────────────────────────────────────────────
app.post('/api/battle', async (req, res) => {
  const { username1, username2 } = req.body;

  if (!username1 || !username2) {
    return res.status(400).json({ error: 'Both usernames are required' });
  }
  if (username1.toLowerCase() === username2.toLowerCase()) {
    return res.status(400).json({ error: 'Enter two different usernames' });
  }

  const token = req.session?.token || null;

  try {
    // Fetch both users in parallel
    const [p1, p2] = await Promise.all([
      buildUserData(username1, token),
      buildUserData(username2, token),
    ]);

    const winner = p1.score >= p2.score ? 'p1' : 'p2';

    res.json({ p1, p2, winner });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('rate limit') ? 429
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚔️  GitHub Battle backend running on http://localhost:${PORT}`);
  console.log(`   Frontend origin: ${FRONTEND_URL}`);
  console.log(`   OAuth configured: ${!!GITHUB_CLIENT_ID}\n`);
});
