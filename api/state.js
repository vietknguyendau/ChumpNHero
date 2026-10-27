import { Redis } from "@upstash/redis";

// Works with Vercel's Upstash Redis integration (KV_* vars) or plain Upstash vars.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const K = { bowlers: "ch:bowlers", nights: "ch:nights", settings: "ch:settings" };
const DEFAULTS = { team: "Our Team", games: 3, fine: 0 };

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const values = (h) => (h ? Object.values(h).map(parse) : []);
const uid = () => Math.random().toString(36).slice(2, 10);

async function readState() {
  const [bowlers, nights, settings] = await Promise.all([
    redis.hgetall(K.bowlers),
    redis.hgetall(K.nights),
    redis.get(K.settings),
  ]);
  return {
    ...DEFAULTS,
    ...(parse(settings) || {}),
    pinRequired: Boolean(process.env.TEAM_PIN),
    bowlers: values(bowlers).sort((a, b) => a.created - b.created),
    nights: values(nights),
  };
}

const bad = (res, msg) => res.status(400).json({ error: msg });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") return res.status(200).json(await readState());
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const pin = process.env.TEAM_PIN;
    if (pin && req.headers["x-team-pin"] !== pin) {
      return res.status(401).json({ error: "Wrong or missing team PIN" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { action } = body;

    if (action === "addBowler") {
      const name = String(body.name || "").trim().slice(0, 30);
      if (!name) return bad(res, "Name is required");
      const b = { id: uid(), name, created: Date.now() };
      await redis.hset(K.bowlers, { [b.id]: JSON.stringify(b) });
    } else if (action === "removeBowler") {
      await redis.hdel(K.bowlers, String(body.id));
    } else if (action === "addNight") {
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, "Bad date");
      const scores = {};
      for (const [id, arr] of Object.entries(body.scores || {})) {
        if (!Array.isArray(arr)) continue;
        const clean = arr.slice(0, 5).map((v) =>
          typeof v === "number" && v >= 0 && v <= 300 ? Math.round(v) : null
        );
        if (clean.some((v) => v !== null)) scores[String(id).slice(0, 20)] = clean;
      }
      if (Object.keys(scores).length < 2) return bad(res, "Need scores for at least two bowlers");
      const n = { id: uid(), date, scores, created: Date.now() };
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
    } else if (action === "deleteNight") {
      await redis.hdel(K.nights, String(body.id));
    } else if (action === "settings") {
      const cur = { ...DEFAULTS, ...(parse(await redis.get(K.settings)) || {}) };
      if (body.team !== undefined) cur.team = String(body.team).trim().slice(0, 40) || cur.team;
      if (body.games !== undefined) cur.games = Math.max(1, Math.min(5, Math.round(+body.games || 3)));
      if (body.fine !== undefined) cur.fine = Math.max(0, +body.fine || 0);
      await redis.set(K.settings, JSON.stringify(cur));
    } else {
      return bad(res, "Unknown action");
    }

    return res.status(200).json(await readState());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error. Check that the Redis database is connected." });
  }
}
