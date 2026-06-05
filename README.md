# GitHub Battle — Backend ⚔️

Express.js backend for the GitHub Battle frontend. Provides:

- **GitHub OAuth 2.0** — login flow, session management, logout
- **`POST /api/battle`** — fetches both GitHub profiles and returns computed battle data
- **CORS + cookie sessions** — secure cross-origin communication with the frontend

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Create your `.env`
```bash
cp .env.example .env
```

Then fill in the values (see section below).

### 3. Run
```bash
npm run dev   # development (auto-restarts on file change, Node 18+)
npm start     # production
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | Yes | From your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | Yes | From your GitHub OAuth App |
| `GITHUB_TOKEN` | Optional | Personal access token for higher rate limits (60→5000 req/hr for anonymous visitors) |
| `SESSION_SECRET` | Yes | Any long random string |
| `FRONTEND_URL` | Yes | Origin of your frontend (e.g. `http://localhost:5500`) |
| `BACKEND_URL` | Yes | Where this server runs (used in OAuth redirect URI) |
| `PORT` | No | Defaults to `3000` |

### Setting up the GitHub OAuth App

1. Go to **GitHub → Settings → Developer Settings → OAuth Apps → New OAuth App**
2. Set:
   - **Homepage URL**: your frontend URL (e.g. `http://localhost:5500`)
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
3. Copy the **Client ID** and generate a **Client Secret** → paste into `.env`

---

## API Reference

### `GET /auth/github`
Redirects the user to GitHub for OAuth authorization.

### `GET /auth/github/callback`
GitHub redirects here after auth. Exchanges code for token, stores in session, redirects to frontend with `?auth=success` or `?auth=failed`.

### `GET /auth/me`
Returns the currently logged-in user from session.
```json
{ "loggedIn": true, "user": { "login": "...", "name": "...", "avatar": "..." } }
```

### `POST /auth/logout`
Destroys the session.

### `POST /api/battle`
**Body:** `{ "username1": "torvalds", "username2": "gaearon" }`

**Returns:**
```json
{
  "p1": { "login": "torvalds", "stars": 12345, "score": 99000, ... },
  "p2": { "login": "gaearon", "stars": 8000, "score": 75000, ... },
  "winner": "p1"
}
```

Logged-in users automatically use their OAuth token (5000 req/hr). Anonymous users fall back to `GITHUB_TOKEN` if set, otherwise unauthenticated (60 req/hr).

---

## Deploying to Render / Railway / Fly.io

1. Set all env vars in the platform's dashboard
2. Set `NODE_ENV=production`
3. Update `FRONTEND_URL` to your live frontend URL
4. Update `BACKEND_URL` to your live backend URL
5. Update the GitHub OAuth App callback URL to match `BACKEND_URL`

The frontend's `API_BASE` already has `https://github-battle-1.onrender.com` as the production URL — update that constant in `index.html` to match your deploy URL.
