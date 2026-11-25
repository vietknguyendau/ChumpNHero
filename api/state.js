import { Redis } from "@upstash/redis";
import crypto from "crypto";

// Works with Vercel's Upstash Redis integration (KV_* vars) or plain Upstash vars.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const K = {
  bowlers: "ch:bowlers", nights: "ch:nights", settings: "ch:settings",
  live: "ch:live", liveMeta: "ch:livemeta", liveTot: "ch:livetot", liveJar: "ch:livejar", liveNotes: "ch:livenotes", liveShots: "ch:liveshots",
  poker: "ch:poker", pokerManual: "ch:pokermanual", pins: "ch:pins", deck: "ch:pdeck:",
};
const DEFAULTS = { team: "Our Team", games: 3 };
// Chump & Hero Jar amounts in dollars (editable in the app).
const DEFAULT_JAR = {
  gutter1: 1, gutter2: 0.5, openSingle: 0.5, foul: 1, splitCaused: 0.5,
  splitConv: 2, bigSplitConv: 5, double: 0.25, triple: 0.5, fourBagger: 1, moreStrikes: 1, clutch10: 1, game200: 1,
  chump: 0, buyin: 0, pokerAnte: 1,
};
const JAR_TAPS = ["gutter1", "gutter2", "openSingle", "foul", "splitCaused",
  "splitConv", "bigSplitConv", "double", "triple", "fourBagger", "moreStrikes", "clutch10", "game200"]; // no buy-ins: the jar is only fines and bounties
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
  jar.buyin = 0;
  s.jar = jar;
  s.bigSplitPot = Boolean(raw.bigSplitPot);
  s.customJar = cleanCustom(raw.customJar);
  s.pokerOn = raw.pokerOn !== false;
  s.hdcp = cleanHdcp(raw.hdcp);
  // League-sheet checkpoints, so week-by-week history survives pasting a newer sheet.
  s.hdcpHistory = Array.isArray(raw.hdcpHistory) ? raw.hdcpHistory.filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.asOf) && x.b).slice(-40) : [];
  s.bigGame = +raw.bigGame >= 100 && +raw.bigGame <= 300 ? Math.round(+raw.bigGame) : 200; // score that earns the big-game bounty
  delete s.fine;
  return s;
}
// Live games are stored as {r: rolls, s: {rollIndex: "s" | "b"}} (s = split, b = 7-10 / Greek Church).
const normLive = (x) => (Array.isArray(x) ? { r: x, s: {}, L: [], M: [] } : { r: x.r || [], s: x.s || {}, L: x.L || [], M: x.M || [] });
// How each 0 happened: gutter, miss or foul. Anything else is dropped.
const cleanMarks = (rolls, M) => rolls.map((v, i) => (v === 0 && Array.isArray(M) && ["g", "m", "f"].includes(M[i]) ? M[i] : null));
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
// Pins that count as connected: touching neighbors, plus "double wood" (one pin directly behind another: 1-5, 2-8, 3-9).
const ADJ={1:[2,3,5],2:[1,3,4,5,8],3:[1,2,5,6,9],4:[2,5,7,8],5:[1,2,3,4,6,8,9],6:[3,5,9,10],7:[4,8],8:[2,4,5,7,9],9:[3,5,6,8,10],10:[6,9]};
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
// Clutch 10th, a clean finish: X X X, a strike then a spare (X 7 /), or a spare then a strike (9 / X).
function clean10(r){const t=tenthRolls(r);if(t.length!==3)return false;
  if(t[0]===10)return t[1]===10?t[2]===10:t[1]+t[2]===10;
  return t[0]+t[1]===10&&t[2]===10}
// Jar events the app can detect from the rolls (and pin leaves, when the pin deck was used).
// M marks how a 0 happened: 'g' gutter, 'm' miss (stayed on the lane), 'f' foul. Only a real gutter is a gutter fine.
function autoJar(r,L,M){
  L=L||[];M=M||[];const ev=[];let streak=0;
  for(let i=0;i<r.length;i++){
    const st=nextBall(r.slice(0,i)).max,first=st===10;
    if(M[i]==='f')ev.push({k:'foul',i});
    if(first){
      if(r[i]===0&&M[i]==='g')ev.push({k:'gutter1',i});
      if(r[i]===10){streak++;if(streak===2)ev.push({k:'double',i});if(streak===3)ev.push({k:'triple',i});if(streak===4)ev.push({k:'fourBagger',i});if(streak>=5)ev.push({k:'moreStrikes',i})}else streak=0;
      const m=L[i];if(typeof m==='number'&&r[i]<10&&isSplit(m))ev.push({k:'splitCaused',i});
    }else{
      if(st===1&&r[i]===0)ev.push({k:'openSingle',i});
      if(r[i]===0&&M[i]==='g')ev.push({k:'gutter2',i});
      const m=L[i-1];if(typeof m==='number'&&isSplit(m)&&r[i]===st)ev.push({k:bigKind(m)?'bigSplitConv':'splitConv',i});
    }
  }
  if(nextBall(r).done&&clean10(r))ev.push({k:'clutch10',i:r.length-1});
  return ev;
}
// Which frame each roll belongs to.
function frameOfRolls(r){const out=[];let i=0;for(let f=0;f<9&&i<r.length;f++){if(r[i]===10){out[i]=f;i++}else{out[i]=f;if(i+1<r.length)out[i+1]=f;i+=2}}for(;i<r.length;i++)out[i]=9;return out}

// ---- Bowling poker ----
// Cards are strings like "AS" (ace of spades) or "TH" (ten of hearts).
const RANKS='23456789TJQKA',SUITS='SHDC';
// Marks = racks cleared: strikes and spares, fill balls in the 10th included. Each mark earns a card.
function marksOf(r){let n=0;for(let i=0;i<r.length;i++)if(r[i]===nextBall(r.slice(0,i)).max)n++;return n}
// Cards earned, one entry per card (the frame it came in): first strike 1, every strike after it in a row 2 (never more),
// spare 1, converted split 2 (split known from the pin deck's leave).
function cardFrames(r,L){
  L=L||[];const fr=frameOfRolls(r),out=[];let streak=0;
  for(let i=0;i<r.length;i++){
    const st=nextBall(r.slice(0,i)).max,first=st===10;let n=0;
    if(first){if(r[i]===10){streak++;n=streak>=2?2:1}else streak=0}
    else if(r[i]===st)n=typeof L[i-1]==='number'&&isSplit(L[i-1])?2:1;
    for(let k=0;k<n;k++)out.push(fr[i]);
  }
  return out;
}
// Whose turn it is: everyone bowls frame 1 in lineup order, then frame 2, and so on.
// out(id) = not bowling frames this game (typed total or skipped). Returns {id, frame} or null when all are done.
function turnOf(order,rollsOf,out){
  let best=null,min=99;
  order.forEach(id=>{if(out(id))return;const nb=nextBall(rollsOf(id)||[]);if(nb.done)return;if(nb.frame<min){min=nb.frame;best=id}});
  return best?{id:best,frame:min}:null;
}
const framesDone=r=>{const nb=nextBall(r||[]);return nb.done?10:nb.frame};
// Score up to 5 cards. Straights and flushes need all 5; fewer cards can still make pairs, trips and quads.
function score5(cs){
  const rv=cs.map(c=>RANKS.indexOf(c[0])+2).sort((a,b)=>b-a),cnt={};rv.forEach(v=>cnt[v]=(cnt[v]||0)+1);
  const gr=Object.entries(cnt).map(([v,n])=>[n,+v]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]),kick=gr.map(g=>g[1]);
  const five=cs.length===5,flush=five&&cs.every(c=>c[1]===cs[0][1]);
  let st=0;if(five&&gr.length===5){if(rv[0]-rv[4]===4)st=rv[0];else if(rv[0]===14&&rv[1]===5)st=5}
  if(st&&flush)return[8,st];
  if(gr[0][0]===4)return[7,...kick];
  if(gr[0][0]===3&&gr[1]&&gr[1][0]===2)return[6,...kick];
  if(flush)return[5,...rv];
  if(st)return[4,st];
  if(gr[0][0]===3)return[3,...kick];
  if(gr[0][0]===2&&gr[1]&&gr[1][0]===2)return[2,...kick];
  if(gr[0][0]===2)return[1,...kick];
  return[0,...kick];
}
function cmpHand(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]===undefined?-1:a[i],y=b[i]===undefined?-1:b[i];if(x!==y)return x-y}return 0}
const RN1={14:'Ace',13:'King',12:'Queen',11:'Jack',10:'Ten',9:'Nine',8:'Eight',7:'Seven',6:'Six',5:'Five',4:'Four',3:'Three',2:'Two'};
const RNS=v=>v===6?'Sixes':RN1[v]+'s';
function handName(s){switch(s[0]){
  case 8:return s[1]===14?'Royal flush':`Straight flush, ${RN1[s[1]]} high`;
  case 7:return `Four ${RNS(s[1])}`;case 6:return `Full house, ${RNS(s[1])} over ${RNS(s[2])}`;
  case 5:return `Flush, ${RN1[s[1]]} high`;case 4:return `Straight, ${RN1[s[1]]} high`;
  case 3:return `Three ${RNS(s[1])}`;case 2:return `Two pair, ${RNS(s[1])} and ${RNS(s[2])}`;
  case 1:return `Pair of ${RNS(s[1])}`;case 0:return `${RN1[s[1]]} high`;default:return 'No cards'}}
// Best hand from any number of cards (best 5, or all of them when fewer than 5).
function bestHand(cards){
  if(!cards||!cards.length)return {score:[-1],cards:[],name:'No cards'};
  const k=Math.min(5,cards.length);let best=null,bc=null;
  const pick=(s,acc)=>{if(acc.length===k){const sc=score5(acc);if(!best||cmpHand(sc,best)>0){best=sc;bc=acc.slice()}return}for(let i=s;i<cards.length;i++){acc.push(cards[i]);pick(i+1,acc);acc.pop()}};
  pick(0,[]);return {score:best,cards:bc,name:handName(best)};
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
  const [pokerRaw, pinsRaw] = await Promise.all([redis.hgetall(K.poker), redis.hgetall(K.pins)]);
  const meta = parse(liveMeta);
  const rolls = {};
  if (live) for (const [k, v] of Object.entries(live)) rolls[k] = normLive(parse(v));
  return {
    ...normalize(parse(settings)),
    pinRequired: Boolean(process.env.TEAM_PIN),
    pokerPins: Object.keys(pinsRaw || {}),
    bowlers: values(bowlers).sort((a, b) => a.created - b.created),
    nights: values(nights),
    live: meta ? {
      ...meta, rolls,
      totals: Object.fromEntries(Object.entries(liveTot || {}).map(([k, v]) => [k, +parse(v)])),
      jar: values(liveJar).sort((a, b) => a.at - b.at),
      notes: Object.fromEntries(Object.entries(liveNotes || {}).map(([k, v]) => [k, parse(v)])),
      shots: Object.fromEntries(Object.entries(liveShots || {}).map(([k, v]) => [k, parse(v)])),
      poker: pokerPublic(pokerRaw),
    } : null,
  };
}

// Jar entries that come from final scores: the big-game bounty and the Chump fine.
// priorNights = nights before this one (for the entering average when Chump uses handicap).
function scoreEvents(scores, jarEvents, settingsNow, priorNights, bowlersAll, games) {
  const jar = settingsNow.jar;
  if ((jar.game200 || 0) > 0) {
    const thr = settingsNow.bigGame || 200;
    for (const [id, arr] of Object.entries(scores)) arr.forEach((v, g) => {
      if (typeof v === "number" && v >= thr && !jarEvents.some((e) => e.b === id && e.k === "game200" && e.g === g))
        jarEvents.push({ id: uid(), b: id, k: "game200", g, f: 9, amt: jar.game200, at: Date.now() + 50, auto: true });
    });
  }
  if ((jar.chump || 0) > 0) {
    const hd = settingsNow.hdcp;
    const hdcpFor = (id) => {
      if (!hd.useForCH) return 0;
      const b = bowlersAll.find((x) => x.id === id) || {};
      let p = +b.sheetPins || 0, gm = +b.sheetGames || 0;
      priorNights.forEach((n) => { if (hd.asOf && n.date <= hd.asOf) return; ((n.scores && n.scores[id]) || []).forEach((v) => { if (typeof v === "number") { p += v; gm++; } }); });
      return gm ? Math.max(0, Math.floor(((hd.basis - Math.floor(p / gm)) * hd.pct) / 100)) : 0;
    };
    const adj = {};
    for (const id of Object.keys(scores)) adj[id] = hdcpFor(id);
    for (let g = 0; g < games; g++) {
      const e = Object.entries(scores).filter(([, a]) => typeof a[g] === "number").map(([b, a]) => [b, a[g] + adj[b]]);
      if (e.length < 2) continue;
      const lo = Math.min(...e.map(([, v]) => v)), hi = Math.max(...e.map(([, v]) => v));
      if (lo === hi) continue;
      e.filter(([, v]) => v === lo).forEach(([b]) => jarEvents.push({ id: uid(), b, k: "chump", g, amt: jar.chump, at: Date.now() }));
    }
  }
}


// ---- Bowling poker (server only: cards never leave the server until showdown, except to a bowler with their PIN) ----
function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
// What every phone may see: card counts and finished showdowns. Never the cards in a live hand.
// A hand record: c = every card dealt (in order), f = the frame each was dealt in, d = cards tossed.
const heldOf = (h) => (h.c || []).filter((x) => !(h.d || []).includes(x));
function pokerPublic(raw) {
  const games = {};
  for (const [f, v] of Object.entries(raw || {})) {
    const p = f.split(":");
    if (p[0] === "h") {
      const g = (games[p[1]] = games[p[1]] || { counts: {} }), n = heldOf(parse(v)).length;
      g.counts[p[2]] = n; if (n > 5) (g.owe = g.owe || {})[p[2]] = n - 5;
    }
    if (p[0] === "r") { const g = (games[p[1]] = games[p[1]] || { counts: {} }); g.result = parse(v); }
  }
  return { games };
}
// Which frame each card-earning mark came in (strikes and spares, in order).
function markFrames(r) { const fr = frameOfRolls(r), out = []; for (let i = 0; i < r.length; i++) if (r[i] === nextBall(r.slice(0, i)).max) out.push(fr[i]); return out; }
// Hands hold at most 5 cards. Cards still owed from an earlier frame are trimmed to the best 5
// before the next card is dealt, so waiting to discard never lets anyone see more cards.
function autoTrim(h, frame) {
  const earlier = (h.c || []).filter((x, i) => h.f[i] < frame && !h.d.includes(x));
  if (earlier.length <= 5) return;
  const keep = bestHand(earlier).cards.slice();
  earlier.forEach((x) => { const k = keep.indexOf(x); if (k >= 0) keep.splice(k, 1); else { h.d.push(x); h.ad.push(x); } });
}
// Discard deadline: once the next bowler throws, anyone in game g still over 5 cards keeps their best 5.
async function trimOthers(g, bowlerId) {
  if (await redis.hget(K.poker, "r:" + g)) return;
  const raw = (await redis.hgetall(K.poker)) || {}, upd = {};
  for (const [f, v] of Object.entries(raw)) {
    const p = f.split(":"); if (p[0] !== "h" || +p[1] !== g || p[2] === bowlerId) continue;
    const h = parse(v); h.d = h.d || []; h.ad = h.ad || []; h.f = h.f || h.c.map((_, i) => i);
    if (heldOf(h).length > 5) { autoTrim(h, Infinity); upd[f] = JSON.stringify(h); }
  }
  if (Object.keys(upd).length) await redis.hset(K.poker, upd);
}
// Work out how many cards a bowler has earned in game g, then deal or take back to match.
// Without pin-deck leaves, a tapped "Split made" / "Big split made" adds the split's extra card.
async function pokerResync(id, g) {
  const key = id + ":" + g, rec = parse(await redis.hget(K.live, key)), L = rec ? normLive(rec) : null;
  const taps = values(await redis.hgetall(K.liveJar)).filter((e) => e.b === id && +e.g === g && (e.k === "splitConv" || e.k === "bigSplitConv")).length;
  let frames;
  if (L && L.r.length) {
    frames = cardFrames(L.r, L.L);
    if (!(L.L || []).some((x) => Number.isInteger(x))) for (let i = 0; i < taps; i++) frames.push(frames.length ? frames[frames.length - 1] : 0);
  } else {
    const n = +(parse(await redis.hget(K.pokerManual, key)) || 0);
    frames = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < taps; i++) frames.push(n ? n - 1 : 0);
  }
  await syncHand(id, g, frames.length, frames);
}
// Deal or take back cards so a bowler has been dealt `target` cards for game g.
// Taken-back cards are kept and dealt again first, so undoing a strike can't re-roll a card.
async function syncHand(id, g, target, frames) {
  if (await redis.hget(K.poker, "r:" + g)) return;
  const f = "h:" + g + ":" + id, cur = parse(await redis.hget(K.poker, f)) || {};
  for (const k of ["c", "back", "f", "d", "ad"]) cur[k] = cur[k] || [];
  while (cur.f.length < cur.c.length) cur.f.push(cur.f.length);
  if (cur.c.length === target) return;
  while (cur.c.length < target) {
    const fr = frames && frames[cur.c.length] !== undefined ? frames[cur.c.length] : cur.c.length;
    autoTrim(cur, fr);
    let c = cur.back.pop();
    if (!c) {
      c = await redis.lpop(K.deck + g);
      if (!c) { await redis.rpush(K.deck + g, ...newDeck()); c = await redis.lpop(K.deck + g); }
    }
    cur.c.push(String(c)); cur.f.push(fr);
  }
  while (cur.c.length > target) {
    const x = cur.c.pop(); cur.f.pop();
    cur.d = cur.d.filter((y) => y !== x); cur.ad = cur.ad.filter((y) => y !== x);
    cur.back.push(x);
  }
  await redis.hset(K.poker, { [f]: JSON.stringify(cur) });
}
const hashPin = (salt, pin) => crypto.createHash("sha256").update(salt + ":" + pin).digest("hex");
// Five wrong tries locks that bowler's PIN for 5 minutes.
async function checkPin(id, pin) {
  const rec = parse(await redis.hget(K.pins, id));
  if (!rec) return { code: 400, error: "No PIN set yet" };
  if (rec.lock && rec.lock > Date.now()) return { code: 429, error: `Too many wrong tries. Try again in ${Math.ceil((rec.lock - Date.now()) / 60000)} min.` };
  if (hashPin(rec.salt, String(pin || "")) !== rec.hash) {
    rec.fails = (rec.fails || 0) + 1;
    if (rec.fails >= 5) { rec.lock = Date.now() + 5 * 60000; rec.fails = 0; }
    await redis.hset(K.pins, { [id]: JSON.stringify(rec) });
    return { code: 403, error: rec.lock > Date.now() ? "Wrong PIN. Locked for 5 minutes." : "Wrong PIN" };
  }
  if (rec.fails) { rec.fails = 0; await redis.hset(K.pins, { [id]: JSON.stringify(rec) }); }
  return { ok: true };
}
async function holdsCardsTonight(id) {
  if (!(await redis.get(K.liveMeta))) return false;
  const raw = (await redis.hgetall(K.poker)) || {};
  return Object.entries(raw).some(([f, v]) => f.startsWith("h:") && f.endsWith(":" + id) && (parse(v).c || []).length && !raw["r:" + f.split(":")[1]]);
}
// Showdown for game g: antes from every player, best hand takes the pot (ties split it).
async function showdown(g, meta, settingsNow) {
  const raw = (await redis.hgetall(K.poker)) || {};
  if (raw["r:" + g]) return parse(raw["r:" + g]);
  const live = (await redis.hgetall(K.live)) || {}, tot = (await redis.hgetall(K.liveTot)) || {};
  const lineup = Array.isArray(meta.lineup) ? meta.lineup : values(await redis.hgetall(K.bowlers)).map((b) => b.id);
  const recOf = (id) => (raw["h:" + g + ":" + id] ? parse(raw["h:" + g + ":" + id]) : {});
  const cardsOf = (id) => heldOf(recOf(id));
  const bowled = lineup.filter((id) => live[id + ":" + g] || tot[id + ":" + g] !== undefined);
  const players = [...new Set((bowled.length ? bowled : lineup).concat(lineup.filter((id) => cardsOf(id).length)))];
  const hands = {};
  players.forEach((id) => { const c = cardsOf(id), b = bestHand(c); hands[id] = { c, best: b.cards, name: b.name, score: b.score, tossed: recOf(id).d || [] }; });
  const result = { players, hands, winners: [], pot: 0, ante: 0, at: Date.now() };
  if (players.some((id) => hands[id].c.length)) {
    let top = null;
    players.forEach((id) => { if (!top || cmpHand(hands[id].score, top) > 0) top = hands[id].score; });
    result.winners = players.filter((id) => cmpHand(hands[id].score, top) === 0);
    const ante = settingsNow.jar.pokerAnte || 0;
    if (ante > 0 && players.length > 1) {
      result.ante = ante; result.pot = Math.round(ante * players.length * 100) / 100;
      const ev = {}, now = Date.now(), share = Math.floor((result.pot * 100) / result.winners.length) / 100;
      let left = Math.round((result.pot - share * result.winners.length) * 100) / 100;
      players.forEach((id) => { const e = { id: uid(), b: id, k: "pokerAnte", g, amt: ante, at: now, auto: true }; ev[e.id] = JSON.stringify(e); });
      result.winners.forEach((id, i) => {
        const amt = Math.round((share + (i === 0 ? left : 0)) * 100) / 100;
        const e = { id: uid(), b: id, k: "pokerWin", g, amt, at: now + 1, auto: true }; ev[e.id] = JSON.stringify(e);
      });
      await redis.hset(K.liveJar, ev);
    }
  } else result.note = "No cards were dealt";
  await redis.hset(K.poker, { ["r:" + g]: JSON.stringify(result) });
  return result;
}
const pokerKeys = () => [K.poker, K.pokerManual, ...[0, 1, 2, 3, 4].map((g) => K.deck + g)];

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
      const b = { id: uid(), name, created: Date.now(), hand: body.hand === "L" || body.hand === "R" ? body.hand : "", sheetPins: intIn(body.sheetPins, 100000), sheetGames: intIn(body.sheetGames, 1000) };
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
    } else if (action === "setHand") {
      const raw = await redis.hget(K.bowlers, String(body.id || ""));
      if (!raw) return bad(res, "That bowler wasn't found");
      const b = parse(raw);
      b.hand = body.hand === "L" || body.hand === "R" ? body.hand : "";
      await redis.hset(K.bowlers, { [b.id]: JSON.stringify(b) });
    } else if (action === "editNightScores") {
      // Fix typed scores on a saved night. Games scored frame by frame stay as the frames say.
      const raw = await redis.hget(K.nights, String(body.nightId || ""));
      if (!raw) return bad(res, "That night wasn't found");
      const n = parse(raw), settingsNow = await getSettings(), games = settingsNow.games;
      const roster = values(await redis.hgetall(K.bowlers));
      for (const [id, arr] of Object.entries(body.scores || {})) {
        if (!roster.some((b) => b.id === id) || !Array.isArray(arr)) continue;
        if (!n.scores[id]) n.scores[id] = Array(games).fill(null);
        for (let g = 0; g < games; g++) {
          if (n.rolls && n.rolls[id] && n.rolls[id][g]) continue;
          const v = arr[g];
          if (v === null || v === "" || v === undefined) n.scores[id][g] = null;
          else if (+v >= 0 && +v <= 300) n.scores[id][g] = Math.round(+v);
          else return bad(res, "Scores must be between 0 and 300");
        }
        if (Array.isArray(n.lineup) && !n.lineup.includes(id) && n.scores[id].some((v) => v !== null)) n.lineup.push(id);
      }
      // Redo the score-based jar entries for this night (taps are kept).
      n.jarEvents = (n.jarEvents || []).filter((e) => e.k !== "chump" && !(e.k === "game200" && e.auto));
      const prior = values(await redis.hgetall(K.nights)).filter((x) => x.id !== n.id && (x.date < n.date || (x.date === n.date && x.created < n.created)));
      scoreEvents(n.scores, n.jarEvents, settingsNow, prior, roster, games);
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
    } else if (action === "removeNightJar") {
      // Fix a mistake in a saved night's jar.
      const raw = await redis.hget(K.nights, String(body.nightId || ""));
      if (!raw) return bad(res, "That night wasn't found");
      const n = parse(raw);
      const before = (n.jarEvents || []).length;
      n.jarEvents = (n.jarEvents || []).filter((e) => e.id !== String(body.id || ""));
      if (n.jarEvents.length === before) return bad(res, "That entry wasn't found");
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
    } else if (action === "removeBowler") {
      await redis.hdel(K.bowlers, String(body.id));
      await redis.hdel(K.pins, String(body.id));
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
      if (body.pokerOn !== undefined) cur.pokerOn = Boolean(body.pokerOn);
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
      // Lineup keeps the order given: that's the bowling order.
      const lineup = Array.isArray(body.lineup) ? body.lineup.filter((id, i, a) => roster.includes(id) && a.indexOf(id) === i) : roster;
      if (!lineup.length) return bad(res, "Pick at least one bowler for tonight");
      for (const k of pokerKeys()) await redis.del(k);
      for (let g = 0; g < 5; g++) await redis.rpush(K.deck + g, ...newDeck());
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
      const prevLen = (normLive(parse(await redis.hget(K.live, key)) || []).r || []).length;
      // Turn order: a new ball only goes in for the bowler who's up, and only finishes their current frame.
      if (rolls.length > prevLen) {
        const meta = parse(await redis.get(K.liveMeta)), order = Array.isArray(meta.lineup) ? meta.lineup : [];
        if (order.includes(id)) {
          const liveAll = (await redis.hgetall(K.live)) || {}, tot = (await redis.hgetall(K.liveTot)) || {}, skip = ((meta.skip || {})[game]) || [];
          const rOf = (b) => (liveAll[b + ":" + game] ? normLive(parse(liveAll[b + ":" + game])).r : []);
          const out = (b) => skip.includes(b) || tot[b + ":" + game] !== undefined;
          // To bowl frame F, everyone ahead in the order must have finished F, and everyone behind must have finished F-1.
          const p = order.indexOf(id), F = frameOfRolls(rolls)[rolls.length - 1];
          const blocked = order.some((q, qi) => q !== id && !out(q) && framesDone(rOf(q)) < (qi < p ? F + 1 : F));
          if (blocked) {
            const t = turnOf(order, rOf, out);
            if (t && t.id !== id) {
              const who = parse(await redis.hget(K.bowlers, t.id));
              return bad(res, `It’s ${who ? who.name : "another bowler"}’s turn (frame ${t.frame + 1}). Wait for them to finish.`);
            }
            return bad(res, "One frame at a time: the next bowler is up after this frame");
          }
        }
      }
      const L = cleanLeaves(rolls, body.leaves);
      const M = cleanMarks(rolls, body.marks);
      if (rolls.length) await redis.hset(K.live, { [key]: JSON.stringify({ r: rolls, s: splits, L, M }) });
      else await redis.hdel(K.live, key);
      if ((await getSettings()).pokerOn && rolls.length > prevLen) await trimOthers(game, id);
      if ((await getSettings()).pokerOn) await pokerResync(id, game);
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
      if ((k === "splitConv" || k === "bigSplitConv") && (await getSettings()).pokerOn) await pokerResync(b, e.g);
    } else if (action === "skipTurn") {
      // A bowler who isn't bowling this game shouldn't hold up the turn order.
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const g = String(Math.round(+body.game)), id = String(body.bowlerId || "");
      meta.skip = meta.skip || {};
      const cur = new Set(meta.skip[g] || []);
      if (body.on === false) cur.delete(id); else cur.add(id);
      meta.skip[g] = [...cur];
      await redis.set(K.liveMeta, JSON.stringify(meta));
    } else if (action === "setLineup") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const roster = values(await redis.hgetall(K.bowlers)).map((b) => b.id);
      const lineup = (Array.isArray(body.lineup) ? body.lineup : []).filter((id, i, a) => roster.includes(id) && a.indexOf(id) === i);
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
        const n = { stand: num(d.stand, 1, 39), target: num(d.target, 1, 39), bp: num(d.bp, 1, 39), ball: txt(d.ball, 30), note: txt(d.note, 200), adjAt: +d.adjAt > 0 ? +d.adjAt : 0, lanes: {},
          cm: intIn(d.cm, 30), cx: intIn(d.cx, 30) }; // corner-pin spares made / missed, logged by tap
        // This bowler's own line and notes for each lane: foot board, mark at the arrows, breakpoint, note.
        for (const [l, x] of Object.entries(d.lanes || {}).slice(0, 2)) {
          if (num(l, 1, 200) === "" || !x) continue;
          n.lanes[+l] = { foot: num(x.foot, 1, 39), mark: num(x.mark, 1, 39), bp: num(x.bp, 1, 39), note: txt(x.note, 200), adjAt: +x.adjAt > 0 ? +x.adjAt : 0 };
        }
        await redis.hset(K.liveNotes, { [id.slice(0, 20) + ":" + Math.round(+g)]: JSON.stringify(n) });
      }
    } else if (action === "removeJar") {
      const gone = parse(await redis.hget(K.liveJar, String(body.id || "")));
      await redis.hdel(K.liveJar, String(body.id || ""));
      if (gone && (gone.k === "splitConv" || gone.k === "bigSplitConv") && (await getSettings()).pokerOn) await pokerResync(gone.b, +gone.g);
    } else if (action === "pokerMark") {
      // Card by tap, for games not scored frame by frame.
      if (!(await redis.get(K.liveMeta))) return bad(res, "No night in progress. Start one first.");
      const id = String(body.bowlerId || "").slice(0, 20), g = Math.round(+body.game), key = id + ":" + g;
      if (!id || !(g >= 0 && g < 5)) return bad(res, "Bad bowler or game");
      if (await redis.hget(K.live, key)) return bad(res, "This game is scored by frames, so cards come from the frames");
      if (await redis.hget(K.poker, "r:" + g)) return bad(res, "That game’s hand has already been shown");
      const n = Math.max(0, Math.min(12, (+(parse(await redis.hget(K.pokerManual, key)) || 0)) + (+body.delta > 0 ? 1 : -1)));
      await redis.hset(K.pokerManual, { [key]: JSON.stringify(n) });
      if (+body.delta > 0) await trimOthers(g, id);
      await pokerResync(id, g);
    } else if (action === "pokerReveal") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const g = Math.round(+body.game);
      if (!(g >= 0 && g < 5)) return bad(res, "Bad game");
      if (await redis.hget(K.poker, "r:" + g)) return bad(res, "That game’s hand has already been shown");
      await showdown(g, meta, await getSettings());
    } else if (action === "setPokerPin") {
      const id = String(body.bowlerId || "").slice(0, 20), pin = String(body.pin || "");
      if (!(await redis.hget(K.bowlers, id))) return bad(res, "That bowler wasn't found");
      if (!/^\d{4,6}$/.test(pin)) return bad(res, "Use 4 to 6 digits");
      if (await redis.hget(K.pins, id)) {
        const c = await checkPin(id, body.oldPin);
        if (!c.ok) return res.status(c.code).json({ error: c.code === 403 ? "Current PIN is wrong" : c.error });
      } else if (await holdsCardsTonight(id)) {
        return bad(res, "Cards were already dealt tonight, so a PIN can only be set after the night. Your cards still count.");
      }
      const salt = crypto.randomBytes(12).toString("hex");
      await redis.hset(K.pins, { [id]: JSON.stringify({ salt, hash: hashPin(salt, pin), fails: 0, lock: 0 }) });
    } else if (action === "resetPokerPin") {
      if (await redis.get(K.liveMeta)) return bad(res, "PINs can only be reset between nights, so nobody can peek at live cards");
      await redis.hdel(K.pins, String(body.bowlerId || ""));
    } else if (action === "pokerHand") {
      // The only way a live hand leaves the server: the bowler's own PIN.
      const id = String(body.bowlerId || "").slice(0, 20);
      const c = await checkPin(id, body.pin);
      if (!c.ok) return res.status(c.code).json({ error: c.error });
      const raw = (await redis.hgetall(K.poker)) || {}, cards = {}, tossed = {}, auto = {};
      for (const [f, v] of Object.entries(raw)) {
        const p = f.split(":"); if (p[0] !== "h" || p[2] !== id) continue;
        const h = parse(v); cards[p[1]] = heldOf(h); tossed[p[1]] = h.d || []; auto[p[1]] = h.ad || [];
      }
      return res.status(200).json({ cards, tossed, auto });
    } else if (action === "pokerDiscard") {
      // Toss cards down to 5. Needs the bowler's PIN, like seeing the hand.
      const id = String(body.bowlerId || "").slice(0, 20), g = Math.round(+body.game);
      const c = await checkPin(id, body.pin);
      if (!c.ok) return res.status(c.code).json({ error: c.error });
      if (!(g >= 0 && g < 5)) return bad(res, "Bad game");
      if (await redis.hget(K.poker, "r:" + g)) return bad(res, "That game’s hand has already been shown");
      const f = "h:" + g + ":" + id, h = parse(await redis.hget(K.poker, f));
      if (!h) return bad(res, "No cards to discard");
      h.d = h.d || []; h.ad = h.ad || [];
      const held = heldOf(h), toss = [...new Set((Array.isArray(body.cards) ? body.cards : []).map(String))];
      if (!toss.length || toss.some((x) => !held.includes(x))) return bad(res, "Pick cards from your hand");
      if (held.length - toss.length < 5) return bad(res, `You can only toss down to 5 cards (toss ${Math.max(0, held.length - 5)})`);
      h.d.push(...toss);
      await redis.hset(K.poker, { [f]: JSON.stringify(h) });
      const h2 = heldOf(h);
      return res.status(200).json({ cards: { [g]: h2 }, tossed: { [g]: h.d }, auto: { [g]: h.ad } });
    } else if (action === "finishNight") {
      const meta = parse(await redis.get(K.liveMeta));
      if (!meta) return bad(res, "No night in progress");
      const { games, jar } = await getSettings();
      // Show down any poker hand still face down.
      const pk0 = (await redis.hgetall(K.poker)) || {}, sNow = await getSettings();
      for (let g = 0; g < games; g++) if (!pk0["r:" + g] && Object.keys(pk0).some((f) => f.startsWith("h:" + g + ":") && (parse(pk0[f]).c || []).length)) await showdown(g, meta, sNow);
      const poker = {};
      for (const [f, v] of Object.entries((await redis.hgetall(K.poker)) || {})) if (f.startsWith("r:")) poker[f.slice(2)] = parse(v);
      const live = (await redis.hgetall(K.live)) || {};
      const await_nights = await redis.hgetall(K.nights);
      const notesRaw = (await redis.hgetall(K.liveNotes)) || {};
      const shotsRaw = (await redis.hgetall(K.liveShots)) || {};
      const liveTot = (await redis.hgetall(K.liveTot)) || {};
      const jarEvents = values(await redis.hgetall(K.liveJar));
      const scores = {}, rolls = {}, splits = {}, leaves = {}, marks = {};
      for (const [k, v] of Object.entries(live)) {
        const [id, g] = k.split(":");
        const gi = +g;
        if (gi >= games) continue;
        const L = normLive(parse(v));
        if (!scores[id]) {
          scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null);
          splits[id] = Array(games).fill(null); leaves[id] = Array(games).fill(null); marks[id] = Array(games).fill(null);
        }
        leaves[id][gi] = L.L; marks[id][gi] = L.M;
        const s = scoreGame(L.r);
        scores[id][gi] = s.complete ? s.total : null;
        rolls[id][gi] = L.r;
        splits[id][gi] = L.s;
      }
      // Typed totals fill any game that wasn't scored frame by frame.
      for (const [k, v] of Object.entries(liveTot)) {
        const [id, g] = k.split(":"), gi = +g;
        if (gi >= games) continue;
        if (!scores[id]) { scores[id] = Array(games).fill(null); rolls[id] = Array(games).fill(null); splits[id] = Array(games).fill(null); leaves[id] = Array(games).fill(null); marks[id] = Array(games).fill(null); }
        if (!rolls[id][gi] && scores[id][gi] === null) scores[id][gi] = +parse(v);
      }
      const anyDone = Object.values(scores).some((a) => a.some((v) => v !== null));
      // Only tonight's lineup counts (anyone removed mid-night is left out).
      const inLineup = (id) => !Array.isArray(meta.lineup) || meta.lineup.includes(id);
      for (const o of [scores, rolls, splits, leaves, marks]) for (const id of Object.keys(o)) if (!inLineup(id)) delete o[id];
      for (let i = jarEvents.length - 1; i >= 0; i--) if (!inLineup(jarEvents[i].b)) jarEvents.splice(i, 1);
      // Fines and bounties detected from the frames.
      const settingsNow = await getSettings();
      const isIn = (e) => (e.fine !== undefined ? e.fine : !["splitConv", "bigSplitConv", "double", "triple", "fourBagger", "moreStrikes", "clutch10", "game200", "pokerWin"].includes(e.k));
      let potBase = null;
      for (const id of Object.keys(rolls)) {
        rolls[id].forEach((r, g) => {
          if (!r) return;
          autoJar(r, leaves[id][g], marks[id] && marks[id][g]).forEach((a) => {
            let amt = jar[a.k] || 0;
            if (a.k === "bigSplitConv" && settingsNow.bigSplitPot) {
              if (potBase === null) {
                const prior = values(await_nights).flatMap((n) => n.jarEvents || []);
                potBase = prior.concat(jarEvents).reduce((s2, e) => s2 + (isIn(e) ? e.amt : -e.amt), 0);
              }
              amt = Math.max(0, potBase); potBase -= amt;
            }
            if (amt > 0) jarEvents.push({ id: uid(), b: id, k: a.k, g, f: frameOfRolls(r)[a.i], amt, at: Date.now() + a.i, auto: true });
          });
        });
      }
      scoreEvents(scores, jarEvents, settingsNow, values(await_nights), values(await redis.hgetall(K.bowlers)), games);
      const notes = {};
      for (const [k, v] of Object.entries(notesRaw)) if (k === "lanes" || inLineup(k.split(":")[0])) notes[k] = parse(v);
      if (!Object.values(scores).some((x) => x.some((v) => v !== null)) && !jarEvents.length && Object.keys(notes).length === 0)
        return bad(res, "Nothing to save yet. Add a score, a jar item or a note first.");
      const shots = {};
      for (const [k, v] of Object.entries(shotsRaw)) if (inLineup(k.split(":")[0])) shots[k] = parse(v);
      const n = { id: uid(), date: meta.date, lineup: meta.lineup, shots, scores, rolls, splits, leaves, marks, jarEvents, notes, poker, created: Date.now() };
      await redis.hset(K.nights, { [n.id]: JSON.stringify(n) });
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveNotes, K.liveShots, K.liveMeta, ...pokerKeys()]) await redis.del(k);
    } else if (action === "cancelNight") {
      for (const k of [K.live, K.liveTot, K.liveJar, K.liveNotes, K.liveShots, K.liveMeta, ...pokerKeys()]) await redis.del(k);
    } else {
      return bad(res, "Unknown action");
    }

    return res.status(200).json(await readState());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error. Check that the Redis database is connected." });
  }
}
