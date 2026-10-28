import { Redis } from "@upstash/redis";

// Works with Vercel's Upstash Redis integration (KV_* vars) or plain Upstash vars.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const K = {
  bowlers: "ch:bowlers", nights: "ch:nights", settings: "ch:settings",
  live: "ch:live", liveMeta: "ch:livemeta", liveTot: "ch:livetot", liveJar: "ch:livejar", liveNotes: "ch:livenotes", liveShots: "ch:liveshots",
};
const DEFAULTS = { team: "Our Team", games: 3 };
// Chump & Hero Jar amounts in dollars (editable in the app).
const DEFAULT_JAR = {
  gutter1: 1, gutter2: 0.5, openSingle: 0.5, foul: 1, splitCaused: 0.5,
  splitConv: 2, bigSplitConv: 5, fourBagger: 1, clutch10: 1, game200: 1,
  chump: 0, buyin: 0,
};
const JAR_TAPS = ["gutter1", "gutter2", "openSingle", "foul", "splitCaused",
  "splitConv", "bigSplitConv", "fourBagger", "clutch10", "game200", "buyin"];
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
// League handicap: pct% of (basis - average), whole pins. Defaults match the league sheet (90% of 200).
function cleanHdcp(h) {
  h = h || {};
  const n = (v, lo, hi, d) => (+v >= lo && +v <= hi ? Math.round(+v) : d);
  return { basis: n(h.basis, 100, 300, 200), pct: n(h.pct, 0, 100, 90),
    asOf: /^\d{4}-\d{2}-\d{2}$/.test(h.asOf || "") ? h.asOf : "", useForCH: Boolean(h.useForCH) };
}
const intIn = (v, hi) => (+v >= 0 && +v <= hi ? Math.round(+v) : 0);
function normalize(raw) {
  raw = raw || {};
  const s = { ...DEFAULTS, ...raw };
  const saved = raw.jar || {}, jar = { ...DEFAULT_JAR };
  if (raw.fine) jar.chump = +raw.fine;
  for (const k of Object.keys(DEFAULT_JAR)) if (typeof saved[k] === "number") jar[k] = saved[k];
  s.jar = jar;
  s.bigSplitPot = Boolean(raw.bigSplitPot);
  s.customJar = cleanCustom(raw.customJar);
  s.hdcp = cleanHdcp(raw.hdcp);
  // League-sheet checkpoints, so week-by-week history survives pasting a newer sheet.
  s.hdcpHistory = Array.isArray(raw.hdcpHistory) ? raw.hdcpHistory.filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.asOf) && x.b).slice(-40) : [];
  s.bigGame = +raw.bigGame >= 100 && +raw.bigGame <= 300 ? Math.round(+raw.bigGame) : 200; // score that earns the big-game bounty
  delete s.fine;
  return s;
}
// Live games are stored as {r: rolls, s: {rollIndex: "s" | "b"}} (s = split, b = 7-10 / Greek Church).
const normLive = (x) => (Array.isArray(x) ? { r: x, s: {}, L: [] } : { r: x.r || [], s: x.s || {}, L: x.L || [] });
// Pin leaves must agree with the rolls: right number of pins, and only pins that were still up.
function cleanLeaves(rolls, L) {
  if (!Array.isArray(L)) return [];
  const out = [];
  for (let i = 0; i < rolls.length; i++) {
    const m = L[i];
    if (!Number.isInteger(m) || m < 0 || m > ALL_PINS) { out[i] = null; continue; }
    const st = nextBall(rolls.slice(0, i)).max;
    if (popcount(m) !== st - rolls[i]) { out[i] = null; continue; }
    if (st < 10 && Number.isInteger(out[i - 1]) && (m & ~out[i - 1])) { out[i] = null; continue; }
    out[i] = m;
  }
  return out;
}
const num = (v, lo, hi) => (v === "" || v === null || v === undefined || !(+v >= lo && +v <= hi) ? "" : Math.round(+v * 2) / 2);
const txt = (v, n) => String(v || "").slice(0, n);

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

// ---- Pin deck ----
// A leave is a 10-bit mask of pins still standing: bit (p-1) set = pin p standing.
const ALL_PINS=1023;
const PIN_ROWS=[[7,8,9,10],[4,5,6],[2,3],[1]];
const ADJ={1:[2,3],2:[1,3,4,5],3:[1,2,5,6],4:[2,5,7,8],5:[2,3,4,6,8,9],6:[3,5,9,10],7:[4,8],8:[4,5,7,9],9:[5,6,8,10],10:[6,9]};
const bit=p=>1<<(p-1);
const pinsOf=m=>{const o=[];for(let p=1;p<=10;p++)if(m&bit(p))o.push(p);return o};
const maskOf=ps=>ps.reduce((m,p)=>m|bit(p),0);
const popcount=m=>pinsOf(m).length;
// Split: headpin down, 2+ pins standing, and the standing pins aren't all touching.
function isSplit(m){
  if(m&bit(1))return false;
  const ps=pinsOf(m);if(ps.length<2)return false;
  const seen=new Set([ps[0]]),stack=[ps[0]];
  while(stack.length){const p=stack.pop();ADJ[p].forEach(q=>{if((m&bit(q))&&!seen.has(q)){seen.add(q);stack.push(q)}})}
  return seen.size<ps.length;
}
const BIG={'7-10':maskOf([7,10]),'Greek Church':maskOf([4,6,7,9,10]),'Greek Church ':maskOf([4,6,7,8,10]),'4-6-7-10':maskOf([4,6,7,10])};
function bigKind(m){for(const k in BIG)if(BIG[k]===m)return k.trim();return null}
const leaveName=m=>m===0?'clean':pinsOf(m).join('-');
// Rolls of the 10th frame.
function tenthRolls(r){let i=0;for(let f=0;f<9&&i<r.length;f++)i+=r[i]===10?1:2;return r.slice(i)}
function clean10(r){const t=tenthRolls(r);if(t.length<2)return false;if(t[0]===10)return t[1]===10?t.length===3:t.length===3&&t[1]+t[2]===10;return t[0]+t[1]===10}
// Jar events the app can detect from the rolls (and pin leaves, when the pin deck was used).
function autoJar(r,L){
  L=L||[];const ev=[];let streak=0;
  for(let i=0;i<r.length;i++){
    const st=nextBall(r.slice(0,i)).max,first=st===10;
    if(first){
      if(r[i]===0)ev.push({k:'gutter1',i});
      if(r[i]===10){streak++;if(streak===4)ev.push({k:'fourBagger',i})}else streak=0;
      const m=L[i];if(typeof m==='number'&&r[i]<10){const b=bigKind(m);if(b==='7-10'||b==='Greek Church')ev.push({k:'splitCaused',i})}
    }else{
      if(st===1&&r[i]===0)ev.push({k:'openSingle',i});
      else if(r[i]===0)ev.push({k:'gutter2',i});
      const m=L[i-1];if(typeof m==='number'&&isSplit(m)&&r[i]===st)ev.push({k:bigKind(m)?'bigSplitConv':'splitConv',i});
    }
  }
  if(nextBall(r).done&&clean10(r))ev.push({k:'clutch10',i:r.length-1});
  return ev;
}
// Which frame each roll belongs to.
function frameOfRolls(r){const out=[];let i=0;for(let f=0;f<9&&i<r.length;f++){if(r[i]===10){out[i]=f;i++}else{out[i]=f;if(i+1<r.length)out[i+1]=f;i+=2}}for(;i<r.length;i++)out[i]=9;return out}

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
  const [bowlers, nights, settings, live, liveMeta, liveTot, liveJar, liveNotes, liveShots] = await Promise.all([
    redis.hgetall(K.bowlers),
    redis.hgetall(K.nights),
    redis.get(K.settings),
    redis.hgetall(K.live),
    redis.get(K.liveMeta),
    redis.hgetall(K.liveTot),
    redis.hgetall(K.liveJar),
    redis.hgetall(K.liveNotes),
    redis.hgetall(K.liveShots),
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
      notes: Object.fromEntries(Object.entries(liveNotes || {}).map(([k, v]) => [k, parse(v)])),
      shots: Object.fromEntries(Object.entries(liveShots || {}).map(([k, v]) => [k, parse(v)])),
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
      const b = { id: uid(), name, created: Date.now(), sheetPins: intIn(body.sheetPins, 100000), sheetGames: intIn(body.sheetGames, 1000) };
      await redis.hset(K.bowlers, { [b.id]: JSON.stringify(b) });
    } else if (action === "setBases") {
      // Pins and games from the league sheet, as of a date. Nights logged after that date add on top.
      const all = (await redis.hgetall(K.bowlers)) || {};
      const upd = {};
      for (const e of (Array.isArray(body.entries) ? body.entries : []).slice(0, 50)) {
        const cur = all[e.id] ? parse(all[e.id]) : null;
        if (!cur) continue;
        upd[e.id] = JSON.stringify({ ...cur, sheetPins: intIn(e.pins, 100000), sheetGames: intIn(e.games, 1000) });
      }
      if (Object.keys(upd).length) await redis.hset(K.bowlers, upd);
      const cur = await getSettings();
      if (body.hdcp) cur.hdcp = cleanHdcp({ ...cur.hdcp, ...body.hdcp });
      if (cur.hdcp.asOf) {
        const snap = { asOf: cur.hdcp.asOf, b: {} };
        for (const [id, v] of Object.entries(all)) {
          const b = upd[id] ? parse(upd[id]) : parse(v);
          if (b.sheetGames) snap.b[id] = [b.sheetPins || 0, b.sheetGames];
        }
        cur.hdcpHistory = cur.hdcpHistory.filter((x) => x.asOf !== snap.asOf).concat([snap]).sort((a, b) => a.asOf.localeCompare(b.asOf)).slice(-40);
      }
      await redis.set(K.settings, JSON.stringify(cur));
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
      if (body.bigGame !== undefined && +body.bigGame >= 100 && +body.bigGame <= 300) cur.bigGame = Math.round(+body.bigGame);
      if (body.hdcp && typeof body.hdcp === "object") cur.hdcp = cleanHdcp({ ...cur.hdcp, ...body.hdcp });
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
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveNotes, K.liveShots]) await redis.del(k);
      const roster = values(await redis.hgetall(K.bowlers)).map((b) => b.id);
      const lineup = Array.isArray(body.lineup) ? roster.filter((id) => body.lineup.includes(id)) : roster;
      if (!lineup.length) return bad(res, "Pick at least one bowler for tonight");
      await redis.set(K.liveMeta, JSON.stringify({ date, started: Date.now(), lineup }));
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
      const L = cleanLeaves(rolls, body.leaves);
      if (rolls.length) await redis.hset(K.live, { [key]: JSON.stringify({ r: rolls, s: splits, L }) });
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
    } else if (action === "setLineup") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const roster = values(await redis.hgetall(K.bowlers)).map((b) => b.id);
      const lineup = roster.filter((id) => Array.isArray(body.lineup) && body.lineup.includes(id));
      if (!lineup.length) return bad(res, "Keep at least one bowler in tonight's lineup");
      await redis.set(K.liveMeta, JSON.stringify({ ...meta, lineup }));
    } else if (action === "addShot" || action === "removeShot") {
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const id = String(body.bowlerId || "").slice(0, 20), g = Math.round(+body.game);
      if (!id || !(g >= 0 && g < 5)) return bad(res, "Bad bowler or game");
      const key = id + ":" + g, list = parse(await redis.hget(K.liveShots, key)) || [];
      if (action === "removeShot") list.pop();
      else {
        const HITS = ["brooklyn", "high", "pocket", "light", "wayLight"];
        const x = num(body.x, 1, 39), f = Math.round(+body.f);
        if (x === "" || !HITS.includes(body.h) || !(f >= 0 && f <= 9)) return bad(res, "Bad shot read");
        list.push({ f, x, h: body.h, lane: num(body.lane, 1, 200), at: Date.now() });
        if (list.length > 30) list.shift();
      }
      if (list.length) await redis.hset(K.liveShots, { [key]: JSON.stringify(list) });
      else await redis.hdel(K.liveShots, key);
    } else if (action === "setNote") {
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const d = body.data || {};
      if (body.key === "lanes") {
        const pair = [num((d.pair || [])[0], 1, 200), num((d.pair || [])[1], 1, 200)];
        const notes = {};
        for (const [k, v] of Object.entries(d.notes || {}).slice(0, 4)) if (num(k, 1, 200) !== "") notes[+k] = txt(v, 200);
        await redis.hset(K.liveNotes, { lanes: JSON.stringify({ pair, notes }) });
      } else {
        const [id, g] = String(body.key || "").split(":");
        if (!id || !(+g >= 0 && +g < 5)) return bad(res, "Bad note");
        const n = { stand: num(d.stand, 1, 39), target: num(d.target, 1, 39), bp: num(d.bp, 1, 39), ball: txt(d.ball, 30), note: txt(d.note, 200), adjAt: +d.adjAt > 0 ? +d.adjAt : 0, lanes: {} };
        // This bowler's own line and notes for each lane: foot board, mark at the arrows, breakpoint, note.
        for (const [l, x] of Object.entries(d.lanes || {}).slice(0, 2)) {
          if (num(l, 1, 200) === "" || !x) continue;
          n.lanes[+l] = { foot: num(x.foot, 1, 39), mark: num(x.mark, 1, 39), bp: num(x.bp, 1, 39), note: txt(x.note, 200), adjAt: +x.adjAt > 0 ? +x.adjAt : 0 };
        }
        await redis.hset(K.liveNotes, { [id.slice(0, 20) + ":" + Math.round(+g)]: JSON.stringify(n) });
      }
    } else if (action === "removeJar") {
      await redis.hdel(K.liveJar, String(body.id || ""));
    } else if (action === "finishNight") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const { games, jar } = await getSettings();
      const live = (await redis.hgetall(K.live)) || {};
      const await_nights = await redis.hgetall(K.nights);
      const notesRaw = (await redis.hgetall(K.liveNotes)) || {};
      const shotsRaw = (await redis.hgetall(K.liveShots)) || {};
      const liveTot = (await redis.hgetall(K.liveTot)) || {};
      const jarEvents = values(await redis.hgetall(K.liveJar));
      const scores = {}, rolls = {}, splits = {}, leaves = {};
      for (const [k, v] of Object.entries(live)) {
        const [id, g] = k.split(":");
        const gi = +g;
        if (gi >= games) continue;
        const L = normLive(parse(v));
        if (!scores[id]) {
          scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null);
          splits[id] = Array(games).fill(null); leaves[id] = Array(games).fill(null);
        }
        leaves[id][gi] = L.L;
        const s = scoreGame(L.r);
        scores[id][gi] = s.complete ? s.total : null;
        rolls[id][gi] = L.r;
        splits[id][gi] = L.s;
      }
      // Typed totals fill any game that wasn't scored frame by frame.
      for (const [k, v] of Object.entries(liveTot)) {
        const [id, g] = k.split(":"), gi = +g;
        if (gi >= games) continue;
        if (!scores[id]) { scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null); splits[id] = Array(games).fill(null); leaves[id] = Array(games).fill(null); }
        if (!rolls[id][gi] && scores[id][gi] === null) scores[id][gi] = +parse(v);
      }
      const anyDone = Object.values(scores).some((a) => a.some((v) => v !== null));
      // Only tonight's lineup counts (anyone removed mid-night is left out).
      const inLineup = (id) => !Array.isArray(meta.lineup) || meta.lineup.includes(id);
      for (const o of [scores, rolls, splits, leaves]) for (const id of Object.keys(o)) if (!inLineup(id)) delete o[id];
      for (let i = jarEvents.length - 1; i >= 0; i--) if (!inLineup(jarEvents[i].b)) jarEvents.splice(i, 1);
      // Fines and bounties detected from the frames.
      const settingsNow = await getSettings();
      const isIn = (e) => (e.fine !== undefined ? e.fine : !["splitConv", "bigSplitConv", "fourBagger", "clutch10", "game200"].includes(e.k));
      let potBase = null;
      for (const id of Object.keys(rolls)) {
        rolls[id].forEach((r, g) => {
          if (!r) return;
          autoJar(r, leaves[id][g]).forEach((a) => {
            let amt = jar[a.k] || 0;
            if (a.k === "bigSplitConv" && settingsNow.bigSplitPot) {
              if (potBase === null) {
                const prior = values(await_nights).flatMap((n) => n.jarEvents || []);
                potBase = prior.concat(jarEvents).reduce((s2, e) => s2 + (isIn(e) ? e.amt : -e.amt), 0);
              }
              amt = Math.max(0, potBase); potBase -= amt;
            }
            if (amt > 0) jarEvents.push({ id: uid(), b: id, k: a.k, g, amt, at: Date.now(), auto: true });
          });
        });
      }
      // Big-game bounty: every finished game at or above the cutoff (scratch), unless someone already tapped it.
      if ((jar.game200 || 0) > 0) {
        const thr = settingsNow.bigGame || 200;
        for (const [id, arr] of Object.entries(scores)) arr.forEach((v, g) => {
          if (typeof v === "number" && v >= thr && !jarEvents.some((e) => e.b === id && e.k === "game200" && e.g === g))
            jarEvents.push({ id: uid(), b: id, k: "game200", g, amt: jar.game200, at: Date.now(), auto: true });
        });
      }
      // Chump of each game pays the chump fine.
      if (jar.chump > 0) {
        // With "use handicap for Chump & Hero", compare score + handicap (handicap from the entering average).
        const hd = settingsNow.hdcp, bowlersAll = values(await redis.hgetall(K.bowlers)), nightsAll = values(await_nights);
        const hdcpFor = (id) => {
          if (!hd.useForCH) return 0;
          const b = bowlersAll.find((x) => x.id === id) || {};
          let p = +b.sheetPins || 0, gm = +b.sheetGames || 0;
          nightsAll.forEach((n) => { if (hd.asOf && n.date <= hd.asOf) return; ((n.scores && n.scores[id]) || []).forEach((v) => { if (typeof v === "number") { p += v; gm++; } }); });
          return gm ? Math.max(0, Math.floor(((hd.basis - Math.floor(p / gm)) * hd.pct) / 100)) : 0;
        };
        const adj = {};
        for (const id of Object.keys(scores)) adj[id] = hdcpFor(id);
        for (let g = 0; g < games; g++) {
          const e = Object.entries(scores).filter(([, a]) => typeof a[g] === "number").map(([b, a]) => [b, a[g] + adj[b]]);
          if (e.length < 2) continue;
          const lo = Math.min(...e.map(([, v]) => v)), hi = Math.max(...e.map(([, v]) => v));
          if (lo === hi) continue;
          e.filter(([, v]) => v === lo).forEach(([b]) =>
            jarEvents.push({ id: uid(), b, k: "chump", g, amt: jar.chump, at: Date.now() }));
        }
      }
      const notes = {};
      for (const [k, v] of Object.entries(notesRaw)) if (k === "lanes" || inLineup(k.split(":")[0])) notes[k] = parse(v);
      if (!Object.values(scores).some((x) => x.some((v) => v !== null)) && !jarEvents.length && Object.keys(notes).length === 0)
        return bad(res, "Nothing to save yet. Add a score, a jar item or a note first.");
      const shots = {};
      for (const [k, v] of Object.entries(shotsRaw)) if (inLineup(k.split(":")[0])) shots[k] = parse(v);
      const n = { id: uid(), date: meta.date, lineup: meta.lineup, shots, scores, rolls, splits, leaves, jarEvents, notes, created: Date.now() };
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveNotes, K.liveShots, K.liveMeta]) await redis.del(k);
    } else if (action === "cancelNight") {
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveNotes, K.liveShots, K.liveMeta]) await redis.del(k);
    } else {
      return bad(res, "Unknown action");
    }

    return res.status(200).json(await readState());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error. Check that the Redis database is connected." });
  }
}
