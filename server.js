require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const NodeCache = require("node-cache");
const { Redis } = require("@upstash/redis");

// ─────────────────────────────
// APP INIT (MUST BE FIRST)
// ─────────────────────────────
const app = express();

app.set("trust proxy", 1); // important for OAuth + Render later

// ─────────────────────────────
// MIDDLEWARE
// ─────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
}));

app.use(express.json());

// ─────────────────────────────
// TEST ROUTE
// ─────────────────────────────
app.get("/", (req, res) => {
  res.send("🚀 Server is working");
});

// ─────────────────────────────
// CACHE
// ─────────────────────────────
const cache = new NodeCache({ stdTTL: 600 });

// ─────────────────────────────
// REDIS (UPSTASH REST)
// ─────────────────────────────
let redis = null;

if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  redis = Redis.fromEnv();
  console.log("✅ Upstash Redis connected");
} else {
  console.log("⚠️ Redis disabled (memory mode)");
}

// ─────────────────────────────
// MEMORY FALLBACK
// ─────────────────────────────
const memUsers = new Map();
const memBattles = [];
const LIMIT = 100;

// ─────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────
async function storeSaveUser(user) {
  if (redis) {
    await redis.hset("users", { [user.githubId]: JSON.stringify(user) });
  } else {
    memUsers.set(user.githubId, user);
  }
}

async function storeGetUser(id) {
  if (redis) {
    const raw = await redis.hget("users", id);
    return raw ? JSON.parse(raw) : null;
  }
  return memUsers.get(id) || null;
}

// ─────────────────────────────
// SESSION (FIXED FOR AUTH)
// ─────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,      // localhost fix
    sameSite: "lax",    // OAuth fix
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────
// GITHUB STRATEGY
// ─────────────────────────────
passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: process.env.GITHUB_CALLBACK_URL,
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const user = {
      githubId: profile.id,
      login: profile.username,
      name: profile.displayName || profile.username,
      avatar: profile.photos?.[0]?.value || "",
      accessToken,
    };

    await storeSaveUser(user);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.githubId));
passport.deserializeUser(async (id, done) => {
  const user = await storeGetUser(id);
  done(null, user || null);
});

// ─────────────────────────────
// AUTH ROUTES
// ─────────────────────────────
app.get("/auth/github",
  passport.authenticate("github", { scope: ["read:user"] })
);

app.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect(process.env.FRONTEND_URL || "http://localhost:5500");
  }
);

// 🔥 FIXED: Player 1 endpoint
app.get("/auth/me", (req, res) => {
  if (req.user) {
    return res.json({
      loggedIn: true,
      user: {
        login: req.user.login,
        name: req.user.name,
        avatar: req.user.avatar,
      }
    });
  }

  res.json({ loggedIn: false, user: null });
});

// ─────────────────────────────
// HEALTH CHECK
// ─────────────────────────────
app.get("/api/health", async (req, res) => {
  let redisOk = false;

  if (redis) {
    try {
      await redis.set("ping", "pong");
      redisOk = true;
    } catch {}
  }

  res.json({
    status: "ok",
    redis: redis ? (redisOk ? "connected" : "error") : "disabled",
    uptime: process.uptime(),
  });
});

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});