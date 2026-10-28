import { Redis } from "@upstash/redis";

// Works with Vercel's Upstash Redis integration (KV_* vars) or plain Upstash vars.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const K = {
  bowlers: "ch:bowlers", nights: "ch:nights", settings: "ch:settings",
  live: "ch:live", liveMeta: "ch:livemeta", liveTot: "ch:livetot", liveJar: "ch:livejar",
};
const DEFAULTS = { team: "Our Team", games: 3 };
// Chump & Hero Jar amounts in dollars (editable in the app).
const DEFAULT_JAR = {
  gutter1: 1, gutter2: 0.5, openSingle: 0.5, foul: 1, splitCaused: 0.5,
  splitConv: 2, bigSplitConv: 5, fourBagger: 1, clutch10: 1,
  chump: 0, buyin: 0,
};
const JAR_TAPS = ["gutter1", "gutter2", "openSingle", "foul", "splitCaused",
  "splitConv", "bigSplitConv", "fourBagger", "clutch10", "buyin"];
// Team-made buttons, e.g. {k:"c_ab12cd", label:"5-pin miss", fine:true, amt:0.5}
function cleanCustom(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, 12).map((c) => {
    let k = String((c && c.k) || "");
    if (!/^c_[a-z0-9]{4,12}$/.test(k) || seen.has(k)) k = "c_" + uid();
    seen.add(k);
    const label = String((c && c.label) || "").trim().slice(0, 24);
    const amt = Math.max(0, Math.min(100, Math.round((+(c && c.amt) || 0) * 4) / 4));
    return { k, label, fine: c ? c.fine !== false : true, amt };
  }).filter((c) => c.label);
}
function normalize(raw) {
  raw = raw || {};
  const s = { ...DEFAULTS, ...raw };
  const saved = raw.jar || {}, jar = { ...DEFAULT_JAR };
  if (raw.fine) jar.chump = +raw.fine;
  for (const k of Object.keys(DEFAULT_JAR)) if (typeof saved[k] === "number") jar[k] = saved[k];
  s.jar = jar;
  s.bigSplitPot = Boolean(raw.bigSplitPot);
  s.customJar = cleanCustom(raw.customJar);
  delete s.fine;
  return s;
}
// Live games are stored as {r: rolls, s: {rollIndex: "s" | "b"}} (s = split, b = 7-10 / Greek Church).
const normLive = (x) => (Array.isArray(x) ? { r: x, s: {} } : { r: x.r || [], s: x.s || {} });

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const values = (h) => (h ? Object.values(h).map(parse) : []);
const uid = () => Math.random().toString(36).slice(2, 10);

// What the next ball can be. {done:true} once the game is over.
function nextBall(r){
  let i=0;
  for(let f=0;f<9;f++){
    if(i>=r.length) return {max:10,frame:f,ball:0};
    if(r[i]===10){i++;continue}
    if(i+1>=r.length) return {max:10-r[i],frame:f,ball:1};
    i+=2;
  }
  const t=r.slice(i);
  if(t.length===0) return {max:10,frame:9,ball:0};
  if(t.length===1) return {max:t[0]===10?10:10-t[0],frame:9,ball:1};
  if(t.length===2){
    if(t[0]===10) return {max:t[1]===10?10:10-t[1],frame:9,ball:2};
    if(t[0]+t[1]===10) return {max:10,frame:9,ball:2};
  }
  return {done:true};
}
// Frame marks plus running score. total = score through the last frame that can be scored.
function scoreGame(r){
  const d=v=>v===0?'-':String(v), fr=[];
  let i=0,cum=0,ok=true;
  for(let f=0;f<9;f++){
    if(i>=r.length){fr.push({m:[],c:null});ok=false;continue}
    let m,pts=null,adv;
    if(r[i]===10){m=['','X'];adv=1;if(i+2<r.length)pts=10+r[i+1]+r[i+2]}
    else if(i+1<r.length){adv=2;
      if(r[i]+r[i+1]===10){m=[d(r[i]),'/'];if(i+2<r.length)pts=10+r[i+2]}
      else{m=[d(r[i]),d(r[i+1])];pts=r[i]+r[i+1]}}
    else{m=[d(r[i]),''];adv=1}
    if(pts===null)ok=false;
    if(ok){cum+=pts;fr.push({m,c:cum})}else fr.push({m,c:null});
    i+=adv;
  }
  const t=r.slice(i),m=[];
  if(t.length>0)m.push(t[0]===10?'X':d(t[0]));
  if(t.length>1)m.push(t[0]===10?(t[1]===10?'X':d(t[1])):(t[0]+t[1]===10?'/':d(t[1])));
  if(t.length>2){if(t[0]===10&&t[1]!==10)m.push(t[1]+t[2]===10?'/':d(t[2]));else m.push(t[2]===10?'X':d(t[2]))}
  const complete=!!nextBall(r).done;
  if(complete&&ok){cum+=t.reduce((a,b)=>a+b,0);fr.push({m,c:cum})}else fr.push({m,c:null});
  return {frames:fr,total:cum,complete,thru:fr.filter(f=>f.c!==null).length};
}

function legal(rolls) {
  if (!Array.isArray(rolls) || rolls.length > 21) return false;
  for (let i = 0; i < rolls.length; i++) {
    const v = rolls[i], nb = nextBall(rolls.slice(0, i));
    if (nb.done || !Number.isInteger(v) || v < 0 || v > nb.max) return false;
  }
  return true;
}

async function getSettings() {
  return normalize(parse(await redis.get(K.settings)));
}

async function readState() {
  const [bowlers, nights, settings, live, liveMeta, liveTot, liveJar] = await Promise.all([
    redis.hgetall(K.bowlers),
    redis.hgetall(K.nights),
    redis.get(K.settings),
    redis.hgetall(K.live),
    redis.get(K.liveMeta),
    redis.hgetall(K.liveTot),
    redis.hgetall(K.liveJar),
  ]);
  const meta = parse(liveMeta);
  const rolls = {};
  if (live) for (const [k, v] of Object.entries(live)) rolls[k] = normLive(parse(v));
  return {
    ...normalize(parse(settings)),
    pinRequired: Boolean(process.env.TEAM_PIN),
    bowlers: values(bowlers).sort((a, b) => a.created - b.created),
    nights: values(nights),
    live: meta ? {
      ...meta, rolls,
      totals: Object.fromEntries(Object.entries(liveTot || {}).map(([k, v]) => [k, +parse(v)])),
      jar: values(liveJar).sort((a, b) => a.at - b.at),
    } : null,
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
      const cur = await getSettings();
      if (body.team !== undefined) cur.team = String(body.team).trim().slice(0, 40) || cur.team;
      if (body.games !== undefined) cur.games = Math.max(1, Math.min(5, Math.round(+body.games || 3)));
      if (Array.isArray(body.customJar)) cur.customJar = cleanCustom(body.customJar);
      if (body.bigSplitPot !== undefined) cur.bigSplitPot = Boolean(body.bigSplitPot);
      if (body.jar && typeof body.jar === "object") {
        for (const k of Object.keys(DEFAULT_JAR)) {
          if (body.jar[k] !== undefined) cur.jar[k] = Math.max(0, Math.min(100, Math.round((+body.jar[k] || 0) * 100) / 100));
        }
      }
      await redis.set(K.settings, JSON.stringify(cur));

    // ---- Live, frame-by-frame night ----
    } else if (action === "startNight") {
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, "Bad date");
      if (await redis.get(K.liveMeta)) return bad(res, "A night is already in progress");
      await redis.del(K.live); await redis.del(K.liveTot); await redis.del(K.liveJar);
      await redis.set(K.liveMeta, JSON.stringify({ date, started: Date.now() }));
    } else if (action === "setRolls") {
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const id = String(body.bowlerId || "").slice(0, 20);
      const game = Math.round(+body.game);
      if (!id || !(game >= 0 && game < 5)) return bad(res, "Bad bowler or game");
      if (!legal(body.rolls)) return bad(res, "Those rolls aren't possible");
      const rolls = body.rolls, splits = {};
      if (body.splits && typeof body.splits === "object") {
        for (const [k, v] of Object.entries(body.splits)) {
          const i = +k;
          if (!Number.isInteger(i) || i < 0 || i >= rolls.length || (v !== "s" && v !== "b")) continue;
          if (nextBall(rolls.slice(0, i)).max !== 10 || rolls[i] > 8) continue; // must be a first ball leaving 2+ pins
          splits[i] = v;
        }
      }
      const key = id + ":" + game;
      if (rolls.length) await redis.hset(K.live, { [key]: JSON.stringify({ r: rolls, s: splits }) });
      else await redis.hdel(K.live, key);
    } else if (action === "setTotal") {
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const id = String(body.bowlerId || "").slice(0, 20), game = Math.round(+body.game);
      if (!id || !(game >= 0 && game < 5)) return bad(res, "Bad bowler or game");
      const key = id + ":" + game;
      if (body.total === null || body.total === "" || body.total === undefined) await redis.hdel(K.liveTot, key);
      else {
        const t = Math.round(+body.total);
        if (!(t >= 0 && t <= 300)) return bad(res, "Scores must be between 0 and 300");
        await redis.hset(K.liveTot, { [key]: JSON.stringify(t) });
      }
    } else if (action === "addJar") {
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const b = String(body.bowlerId || "").slice(0, 20), k = String(body.k || "");
      const custom = (await getSettings()).customJar.find((c) => c.k === k);
      if (!b || (!JAR_TAPS.includes(k) && !custom)) return bad(res, "Unknown jar item");
      const amt = Math.max(0, Math.min(1000, Math.round((+body.amt || 0) * 100) / 100));
      const e = { id: uid(), b, k, g: Math.max(0, Math.min(4, Math.round(+body.game || 0))), amt, at: Date.now() };
      if (custom) { e.label = custom.label; e.fine = custom.fine; } // kept even if the button is deleted later
      await redis.hset(K.liveJar, { [e.id]: JSON.stringify(e) });
    } else if (action === "removeJar") {
      await redis.hdel(K.liveJar, String(body.id || ""));
    } else if (action === "finishNight") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const { games, jar } = await getSettings();
      const live = (await redis.hgetall(K.live)) || {};
      const liveTot = (await redis.hgetall(K.liveTot)) || {};
      const jarEvents = values(await redis.hgetall(K.liveJar));
      const scores = {}, rolls = {}, splits = {};
      for (const [k, v] of Object.entries(live)) {
        const [id, g] = k.split(":");
        const gi = +g;
        if (gi >= games) continue;
        const L = normLive(parse(v));
        if (!scores[id]) {
          scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null); splits[id] = Array(games).fill(null);
        }
        const s = scoreGame(L.r);
        scores[id][gi] = s.complete ? s.total : null;
        rolls[id][gi] = L.r;
        splits[id][gi] = L.s;
      }
      // Typed totals fill any game that wasn't scored frame by frame.
      for (const [k, v] of Object.entries(liveTot)) {
        const [id, g] = k.split(":"), gi = +g;
        if (gi >= games) continue;
        if (!scores[id]) { scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null); splits[id] = Array(games).fill(null); }
        if (!rolls[id][gi] && scores[id][gi] === null) scores[id][gi] = +parse(v);
      }
      const anyDone = Object.values(scores).some((a) => a.some((v) => v !== null));
      if (!anyDone && !jarEvents.length) return bad(res, "Enter at least one score before saving the night");
      // Chump of each game pays the chump fine.
      if (jar.chump > 0) {
        for (let g = 0; g < games; g++) {
          const e = Object.entries(scores).filter(([, a]) => typeof a[g] === "number");
          if (e.length < 2) continue;
          const lo = Math.min(...e.map(([, a]) => a[g])), hi = Math.max(...e.map(([, a]) => a[g]));
          if (lo === hi) continue;
          e.filter(([, a]) => a[g] === lo).forEach(([b]) =>
            jarEvents.push({ id: uid(), b, k: "chump", g, amt: jar.chump, at: Date.now() }));
        }
      }
      const n = { id: uid(), date: meta.date, scores, rolls, splits, jarEvents, created: Date.now() };
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveMeta]) await redis.del(k);
    } else if (action === "cancelNight") {
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveMeta]) await redis.del(k);
    } else {
      return bad(res, "Unknown action");
    }

    return res.status(200).json(await readState());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error. Check that the Redis database is connected." });
  }
}
