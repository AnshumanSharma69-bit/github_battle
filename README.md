# GitFut ⚽ — GitHub Battle Arena
Turn any GitHub profile into a FIFA Ultimate Team card, or battle two developers head-to-head.

**Frontend:** `index.html` (static, deploy to Vercel). **Backend:** `server.js` (Express, deploy to Render/Railway).

## Setup
```
npm install
cp .env.example .env   # fill in values
npm run dev
```
Set `API` at the top of the script in `index.html` to your deployed backend URL. `FRONTEND_URL` accepts a comma-separated list of allowed origins.

## API
- `GET /api/profile/:username` — one player's stats (cached 5 min)
- `POST /api/battle` `{username1, username2}` — both profiles + winner
- `GET /auth/github`, `/auth/github/callback`, `/auth/me`, `POST /auth/logout`

## What's new in v3
Single-card mode, head-to-head attribute bars, PNG download, shareable links (`?u=` / `?u1=&u2=`), history, caching, rate limiting, username validation, OAuth CSRF `state`, forks excluded from stats, log-damped power score, up to 300 repos.
