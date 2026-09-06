'use strict';

/*
 * lovkar-supporters
 * Holds the list of Patreon supporters for Lovkar's Minecraft mods and serves it
 * so the mods can grant COSMETIC-ONLY in-game perks. Nothing here touches gameplay.
 *
 * Public:
 *   GET  /supporters.json     -> { v: 2, salt, supporters: [ { h, tier, aura, colossus } ] }
 *                                h = sha256(salt + ":" + uuid) - the list names nobody; a mod
 *                                hashes the players it meets and looks them up.
 *   GET  /credits.json        -> names of supporters who OPTED IN to be credited, by tier
 *   GET  /healthz             -> { ok, count, patreon }
 *   GET  /link/start          -> begins Patreon linking (the mod opens this in a browser, after
 *                                telling Mojang's session server it is "joining" a one-off server id;
 *                                we ask Mojang whether that account really did -> proof of ownership)
 *   GET  /link/callback       -> Patreon OAuth callback: stores UUID<->tier, shows the aura chooser
 *   POST /link/style          -> { token, aura, colossus, credits } saves the chooser (token from the callback page;
 *                                every choice is checked against the tier that paid for it)
 *   POST /api/me/cosmetics    -> { uuid, name, sid, aura?, colossus?, credits? } from the game: Mojang-verified, same checks
 *   POST /webhook/patreon     -> Patreon webhook, HMAC-verified, auto-syncs tiers. A cancelled pledge does not
 *                                strip the cosmetics at once: the entry keeps an "expires" date (what Patreon
 *                                says they paid through) and falls off the list when that passes.
 *
 * Admin (header x-admin-token: <ADMIN_TOKEN>, or ?token=):
 *   GET    /                      -> admin web UI (public/admin.html)
 *   GET    /api/supporters        -> full list
 *   POST   /api/supporters        -> { name, tier, note? }  (resolves UUID from Mojang)
 *   DELETE /api/supporters/:key   -> remove by uuid or name
 *
 * Data lives in /data/supporters.json (Docker volume), written atomically.
 */

const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'supporters.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TIERS = ['waker', 'colossus', 'titan']; // ascending rank; free tier gets no in-game perk
const TIER_RANK = { waker: 1, colossus: 2, titan: 3 };
const TIER_LABEL = { waker: 'Waker', colossus: 'Colossus', titan: 'Titan' };

// The cosmetics catalogue. Mirrored in the mod (AuraStyle.java) - the mod draws, this decides.
// rank = the tier that unlocks it; a higher tier may wear anything below it. "none" is always allowed.
const AURAS = [
  { id: 'none', rank: 0, name: 'No aura', blurb: 'Keep it quiet - no aura at all.', color: '#8a97a6', pattern: '' },
  { id: 'waker', rank: 1, name: "Waker's Runes", blurb: 'Soft green glyphs rising round your feet.', color: '#5CFF3C', pattern: 'runes' },
  { id: 'colossus', rank: 2, name: 'Colossus Sigil', blurb: 'Glyphs orbit your feet; a ring of light races out every few seconds.', color: '#FF9628', pattern: 'sigil + ring' },
  { id: 'stone', rank: 2, name: 'Stone Sigil', blurb: 'The sigil in the pale grey of the hill colossi.', color: '#D8CFC0', pattern: 'sigil + ring' },
  { id: 'earth', rank: 2, name: 'Earth Sigil', blurb: 'The sigil in the warm brown of the earth colossi.', color: '#B8843C', pattern: 'sigil + ring' },
  { id: 'sandstone', rank: 2, name: 'Sandstone Sigil', blurb: 'The sigil in desert gold.', color: '#F2D27A', pattern: 'sigil + ring' },
  { id: 'ice', rank: 2, name: 'Ice Sigil', blurb: 'The sigil in glacier blue.', color: '#A6E6FF', pattern: 'sigil + ring' },
  { id: 'prismarine', rank: 2, name: 'Prismarine Sigil', blurb: 'The sigil in the sea-green of the deep.', color: '#62D8C8', pattern: 'sigil + ring' },
  { id: 'moss', rank: 2, name: 'Moss Sigil', blurb: 'The sigil in living green.', color: '#8CE664', pattern: 'sigil + ring' },
  { id: 'titan', rank: 3, name: "Titan's Void", blurb: 'The sigil in void purple, a twin pulse, embers boiling up from the ground.', color: '#B266FF', pattern: 'sigil + twin ring + embers' },
  { id: 'crown', rank: 3, name: 'Waking Crown', blurb: 'A halo of gold glyphs turning above your head, shedding embers.', color: '#FFD86A', pattern: 'crown halo + embers' },
];
const AURA_BY_ID = Object.fromEntries(AURAS.map((a) => [a.id, a]));
function defaultAura(tier) { return TIER_RANK[tier] >= 3 ? 'titan' : TIER_RANK[tier] === 2 ? 'colossus' : 'waker'; }
function auraAllowed(tier, auraId) { const a = AURA_BY_ID[auraId]; return !!a && a.rank <= (TIER_RANK[tier] || 0); }

// The looks a supporter's colossi wear (the giants their rites wake). Mirrored in the mod (ColossusStyle.java).
// A style swaps blocks and glow; the silhouette and the hit boxes stay the land's own. The Titan is never dressed.
const COLOSSI = [
  { id: 'none', rank: 0, name: 'The land\'s own', blurb: 'Your colossi rise as they always have - built from the ground they wake in.', color: '#8a97a6' },
  { id: 'sentinel', rank: 2, name: 'The Sentinel', blurb: 'A war machine of blackstone and iron: glowing seams at every joint, a visor for eyes.', color: '#a8f0ff' },
  { id: 'eldest', rank: 2, name: 'The Eldest', blurb: 'A shrine guardian of deepslate, its old carvings picked out in gold light, moss in the cracks.', color: '#ffd24a' },
  { id: 'seraph', rank: 3, name: 'The Seraph', blurb: 'Sleek white plating with violet light along its edges, a visor, and lit horns.', color: '#c88cff' },
];
const COLOSSUS_BY_ID = Object.fromEntries(COLOSSI.map((c) => [c.id, c]));
function colossusAllowed(tier, id) { const c = COLOSSUS_BY_ID[id]; return !!c && c.rank <= (TIER_RANK[tier] || 0); }
function tierNeeded(rank) { return TIER_LABEL[TIERS[rank - 1]] || ''; }
function unlockedFor(tier) {
  const r = TIER_RANK[tier] || 0;
  return { auras: AURAS.filter((a) => a.rank <= r).map((a) => a.id), colossi: COLOSSI.filter((c) => c.rank <= r).map((c) => c.id) };
}
function publicEntry(s) { return { tier: s.tier, aura: s.style.aura, colossus: s.style.colossus, unlocked: unlockedFor(s.tier) }; }

// --- Patreon config (all optional; linking is disabled until these are set) ---
const PATREON_CLIENT_ID = process.env.PATREON_CLIENT_ID || '';
const PATREON_CLIENT_SECRET = process.env.PATREON_CLIENT_SECRET || '';
const PATREON_WEBHOOK_SECRET = process.env.PATREON_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://supporters.lovkarsquid.com').replace(/\/+$/, '');
// Map a Patreon tier TITLE (lower-cased) to our key. Titles: Waker / Colossus / Titan.
const TITLE_TO_TIER = { waker: 'waker', colossus: 'colossus', titan: 'titan' };
// Proof of Minecraft-account ownership via Mojang's session server. On by default; set REQUIRE_MC_VERIFY=0 for offline dev.
const REQUIRE_MC_VERIFY = (process.env.REQUIRE_MC_VERIFY || '1') !== '0';
// Signs the short-lived tokens the chooser page uses. Random per boot unless pinned (tokens live 30 minutes anyway).
const LINK_SECRET = process.env.LINK_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 30 * 60 * 1000;

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error('[fatal] ADMIN_TOKEN env var is required and must be at least 12 characters.');
  process.exit(1);
}
const PATREON_ENABLED = !!(PATREON_CLIENT_ID && PATREON_CLIENT_SECRET);
const PATREON_URL = process.env.PATREON_URL || 'https://www.patreon.com/Lovkar'; // where the tiers live; shown on the pages

// ---------- storage ----------
function emptyStore() {
  return { updated: new Date().toISOString(), salt: newSalt(), supporters: [] };
}
function newSalt() { return crypto.randomBytes(16).toString('base64url'); }
let store = emptyStore();

async function loadStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.supporters)) {
      store = parsed;
      if (!store.salt) { store.salt = newSalt(); console.log('[data] added a hashing salt'); }
      for (const s of store.supporters) normalizeSupporter(s);
      console.log(`[data] loaded ${store.supporters.length} supporter(s) from ${DATA_FILE}`);
      await saveStore();
      return;
    }
    console.warn('[data] file present but malformed - starting empty');
  } catch (err) {
    if (err.code === 'ENOENT') console.log('[data] no file yet - starting empty');
    else console.warn('[data] could not read store:', err.message, '- starting empty');
  }
  await saveStore();
}

let saving = Promise.resolve();
async function saveStore() {
  store.updated = new Date().toISOString();
  saving = saving.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  }).catch((e) => console.error('[data] save failed:', e.message));
  return saving;
}

// Older records (before styles) and any drift: give every supporter a valid style for their tier.
function normalizeSupporter(s) {
  if (!s.style || typeof s.style !== 'object') s.style = {};
  if (!s.style.aura || !auraAllowed(s.tier, s.style.aura)) s.style.aura = defaultAura(s.tier);
  if (!s.style.colossus || !colossusAllowed(s.tier, s.style.colossus)) s.style.colossus = 'none';
  if (typeof s.credits !== 'boolean') s.credits = false;
  if (typeof s.verified !== 'boolean') s.verified = s.source === 'manual';
  return s;
}

// ---------- helpers ----------
function dashUuid(raw) {
  const h = String(raw).replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return String(raw);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function isAdmin(req) {
  const provided = req.get('x-admin-token') || req.query.token || '';
  return provided && safeEqual(provided, ADMIN_TOKEN);
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.set('WWW-Authenticate', 'Token');
  return res.status(401).json({ error: 'admin token required' });
}
function validUuid(u) { return /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(String(u)); }
function findByUuid(raw) { const h = String(raw).replace(/-/g, '').toLowerCase(); return store.supporters.find((s) => s.uuidRaw === h); }
function findByPatreonId(pid) { return store.supporters.find((s) => s.patreonUserId && s.patreonUserId === String(pid)); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// What the public list publishes for a supporter: hex sha256 of "salt:uuid" (lower-case, dashed uuid).
function hashOf(uuidRaw) {
  return crypto.createHash('sha256').update(store.salt + ':' + dashUuid(uuidRaw)).digest('hex');
}

// Short-lived signed token binding the chooser page to one Minecraft account.
function makeToken(uuidRaw) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = `${uuidRaw}.${exp}`;
  const sig = crypto.createHmac('sha256', LINK_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [uuidRaw, expStr, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(uuidRaw) || !/^\d+$/.test(expStr)) return null;
  const expected = crypto.createHmac('sha256', LINK_SECRET).update(`${uuidRaw}.${expStr}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  if (Date.now() > parseInt(expStr, 10)) return null;
  return uuidRaw;
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { accept: 'application/json', ...(opts.headers || {}) } });
    return r;
  } finally { clearTimeout(t); }
}

async function resolveMojang(name) {
  const r = await fetchJson('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name));
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw new Error('Mojang API returned ' + r.status);
  const j = await r.json();
  if (!j || !j.id) return null;
  return { uuidRaw: j.id.toLowerCase(), uuid: dashUuid(j.id), name: j.name };
}

// Did this account just "join" the one-off server id the mod made up? That is the same handshake every
// multiplayer login does, and only a client logged into that account can perform it.
async function verifyMojangJoin(name, serverId) {
  const url = 'https://sessionserver.mojang.com/session/minecraft/hasJoined?' + new URLSearchParams({ username: name, serverId }).toString();
  const r = await fetchJson(url);
  if (r.status === 204) return null;
  if (!r.ok) throw new Error('Mojang session server returned ' + r.status);
  const j = await r.json();
  if (!j || !j.id) return null;
  return { uuidRaw: String(j.id).replace(/-/g, '').toLowerCase(), name: j.name || name };
}

// Choose the highest-ranked tier key from a list of Patreon tier titles.
function bestTierFromTitles(titles) {
  let best = null;
  for (const raw of titles) {
    const key = TITLE_TO_TIER[String(raw).trim().toLowerCase()];
    if (key && (!best || TIER_RANK[key] > TIER_RANK[best])) best = key;
  }
  return best;
}

// --- when a pledge ends ---
// A supporter has already paid for the period they are in, so the cosmetics run to the end of it
// instead of stopping the moment they cancel. Patreon tells us the date: next_charge_date is what
// they are paid through; last_charge_date + one period is the fallback when the pledge is already gone.
const PERIOD_MS = 31 * 24 * 3600 * 1000;
function paidThrough(attrs) {
  const at = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
  const next = at(attrs && attrs.next_charge_date);
  const last = at(attrs && attrs.last_charge_date);
  const until = Math.max(next, last ? last + PERIOD_MS : 0);
  return until > Date.now() ? new Date(until).toISOString() : null;
}
function expired(s) { const t = Date.parse(s.expires || ''); return Number.isFinite(t) && t <= Date.now(); }
// Drop the entries whose paid-for time has run out. Cheap, so it runs before every read of the list.
function sweepExpired() {
  const gone = store.supporters.filter(expired);
  if (!gone.length) return false;
  store.supporters = store.supporters.filter((s) => !expired(s));
  for (const s of gone) console.log(`[patreon] ${s.name} (${s.uuid}) pledge ended - perks expired`);
  saveStore().catch((e) => console.error('[data] save after sweep failed:', e.message));
  return true;
}

// Upsert a supporter identified by Minecraft uuid. Extra fields merged in. Keeps a valid style for the (new) tier.
async function upsertSupporter({ uuid, name, tier, extra = {} }) {
  const uuidRaw = String(uuid).replace(/-/g, '').toLowerCase();
  const now = new Date().toISOString();
  let s = store.supporters.find((x) => x.uuidRaw === uuidRaw);
  if (s) {
    s.name = name || s.name;
    s.tier = tier;
    s.updated = now;
    Object.assign(s, extra);
  } else {
    s = { uuid: dashUuid(uuid), uuidRaw, name: name || '', tier, note: '', source: 'manual', added: now, updated: now, ...extra };
    store.supporters.push(s);
  }
  normalizeSupporter(s);
  await saveStore();
  return s;
}

// A very small per-IP limiter for the endpoints that call out to Mojang/Patreon.
const hits = new Map();
function limited(req, key, max, windowMs) {
  const now = Date.now();
  const k = key + '|' + (req.ip || 'x');
  const h = hits.get(k) || [];
  const recent = h.filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(kk);
  return recent.length > max;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);

// Raw body ONLY for the Patreon webhook (needed for HMAC); JSON for everything else.
app.use('/webhook/patreon', express.raw({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '64kb' }));

// ---- public list the mods fetch: hashes, not names ----
app.get('/supporters.json', (req, res) => {
  sweepExpired();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    v: 2,
    updated: store.updated,
    salt: store.salt,
    supporters: store.supporters.map((s) => ({ h: hashOf(s.uuidRaw), tier: s.tier, aura: s.style.aura, colossus: s.style.colossus })),
  });
});

// ---- the credits: only those who ticked the box ----
app.get('/credits.json', (req, res) => {
  sweepExpired();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  const credits = { titan: [], colossus: [], waker: [] };
  for (const s of store.supporters) if (s.credits && s.name && credits[s.tier]) credits[s.tier].push(s.name);
  for (const k of Object.keys(credits)) credits[k].sort((a, b) => a.localeCompare(b));
  res.json({ updated: store.updated, credits });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, count: store.supporters.length, updated: store.updated, patreon: PATREON_ENABLED, verify: REQUIRE_MC_VERIFY });
});

// ---------- Patreon linking ----------
const linkStates = new Map(); // state -> { uuidRaw, uuid, name, verified, ts }
function newState() { return crypto.randomBytes(24).toString('base64url'); }
function pruneStates() { const cutoff = Date.now() - 10 * 60 * 1000; for (const [k, v] of linkStates) if (v.ts < cutoff) linkStates.delete(k); }

const PAGE_CSS = `body{margin:0;background:#0b0e12;color:#e8edf2;font:16px/1.6 system-ui,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:560px;padding:34px;background:#141a21;border:1px solid #232d38;border-radius:14px;text-align:center;margin:20px}
h1{margin:0 0 10px;font-size:22px}.t{font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.waker{color:#39ff14}.colossus{color:#ff9628}.titan{color:#be5aff}.muted{color:#8a97a6}.big{font-size:40px;margin-bottom:6px}
code{background:#0e141a;border:1px solid #232d38;border-radius:5px;padding:1px 6px}
a{color:#39c6ff}`;

function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

// The page after a successful link: pick an aura (only what the tier unlocks), opt into the credits.
function chooserPage(s, token) {
  const rank = TIER_RANK[s.tier] || 0;
  const ctx = { token, tier: s.tier, tierLabel: TIER_LABEL[s.tier], rank, name: s.name, aura: s.style.aura, colossus: s.style.colossus, credits: !!s.credits,
    auras: AURAS.map((a) => ({ ...a, locked: a.rank > rank, needs: tierNeeded(a.rank) })),
    colossi: COLOSSI.map((c) => ({ ...c, locked: c.rank > rank, needs: tierNeeded(c.rank) })) };
  const json = JSON.stringify(ctx).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Linked - choose your aura</title>
<style>${PAGE_CSS}
body{align-items:flex-start}.card{max-width:760px;text-align:left}
.head{text-align:center}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin:18px 0}
.opt{position:relative;display:block;padding:14px 14px 12px 56px;background:#0e141a;border:1px solid #232d38;border-radius:12px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.opt:hover{border-color:#3a4a5c}.opt input{position:absolute;opacity:0;pointer-events:none}
.opt.sel{border-color:var(--c);box-shadow:0 0 0 1px var(--c),0 0 24px -8px var(--c)}
.opt.locked{opacity:.45;cursor:not-allowed}.opt.locked:hover{border-color:#232d38}
.sw{position:absolute;left:14px;top:16px;width:30px;height:30px;border-radius:50%;background:var(--c);box-shadow:0 0 16px var(--c)}
.opt.none .sw{background:transparent;border:2px dashed #3a4a5c;box-shadow:none}
.nm{font-weight:700;font-size:15px}.bl{color:#8a97a6;font-size:13px;line-height:1.45;margin-top:2px}
.tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:1px 7px;border-radius:999px;background:#1b232c;margin-top:8px}
.lock{position:absolute;right:12px;top:12px;font-size:13px}
.row{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:6px}
label.ck{display:flex;gap:10px;align-items:flex-start;color:#c9d3de;font-size:14px;cursor:pointer;max-width:460px}
label.ck input{margin-top:5px;width:16px;height:16px}
button{cursor:pointer;border:0;border-radius:9px;padding:11px 22px;font-size:15px;font-weight:700;background:#39c6ff;color:#04212e}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:14px;padding:10px 12px;border-radius:9px;font-size:14px;display:none}
.msg.ok{display:block;background:#0f2a16;color:#8effa6;border:1px solid #1c5a2e}.msg.err{display:block;background:#2a0f12;color:#ff9aa2;border:1px solid #5a1c22}
.fine{color:#6f7d8c;font-size:12px;margin-top:18px;text-align:center}
h2.sec{font-size:15px;margin:22px 0 -6px;color:#c9d3de;letter-spacing:.3px}.small{font-size:13px;margin:12px 0 -8px}
</style></head><body><div class="card">
<div class="head"><div class="big">🗿</div>
<h1>Linked — welcome, <span class="t ${esc(s.tier)}">${esc(TIER_LABEL[s.tier] || s.tier)}</span>!</h1>
<p>Your Minecraft account <b>${esc(s.name || s.uuid)}</b> is connected to your Patreon. Thank you for keeping the world waking.</p>
<p class="muted" style="margin-top:-6px">Now choose your look. Everything here is purely cosmetic - it changes nothing about the game itself.</p></div>
<h2 class="sec">Your aura</h2>
<div id="grid" class="grid"></div>
<h2 class="sec">Your colossi</h2>
<p class="muted small">The giants <b>your</b> rites wake rise dressed in this style - same shape, same fight, other stone. The Titan keeps its own look.</p>
<div id="grid2" class="grid"></div>
<div class="row">
  <label class="ck"><input type="checkbox" id="credits"><span>List my Minecraft name in the <b>supporter credits</b> (public). Off by default - nobody's name is published unless they tick this.</span></label>
  <button id="save">Save</button>
</div>
<div id="msg" class="msg"></div>
<p class="fine">Changes show in game within a few minutes (or at once with <code>/wwpatreon refresh</code>). To change later, run <code>/wwpatreon</code> again, or in the game <code>/wwpatreon aura &lt;name&gt;</code> and <code>/wwpatreon colossus &lt;name&gt;</code>. Locked looks belong to higher tiers - upgrading at <a href="${esc(PATREON_URL)}">${esc(PATREON_URL.replace(/^https?:\/\/(www\.)?/, ''))}</a> unlocks them.</p>
</div>
<script>
const CTX = ${json};
let chosen = CTX.aura, chosenColossus = CTX.colossus;
function drawGrid(id, items, current, pick){
  const grid = document.getElementById(id);
  grid.innerHTML = '';
  for (const a of items) {
    const el = document.createElement('label');
    el.className = 'opt' + (a.locked ? ' locked' : '') + (a.id === current ? ' sel' : '') + (a.id === 'none' ? ' none' : '');
    el.style.setProperty('--c', a.color);
    el.innerHTML = '<span class="sw"></span><div class="nm">' + a.name + '</div><div class="bl">' + a.blurb + (a.pattern ? ' <i>(' + a.pattern + ')</i>' : '') + '</div>'
      + (a.rank > 0 ? '<span class="tag ' + ['','waker','colossus','titan'][a.rank] + '">' + a.needs + (a.locked ? ' tier' : '') + '</span>' : '')
      + (a.locked ? '<span class="lock">🔒</span>' : '');
    if (!a.locked) el.onclick = () => pick(a.id);
    grid.appendChild(el);
  }
}
function draw(){
  drawGrid('grid', CTX.auras, chosen, (id) => { chosen = id; draw(); });
  drawGrid('grid2', CTX.colossi, chosenColossus, (id) => { chosenColossus = id; draw(); });
}
draw();
document.getElementById('credits').checked = CTX.credits;
const msg = document.getElementById('msg');
document.getElementById('save').onclick = async () => {
  const btn = document.getElementById('save'); btn.disabled = true; msg.className = 'msg';
  try {
    const r = await fetch('/link/style', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: CTX.token, aura: chosen, colossus: chosenColossus, credits: document.getElementById('credits').checked }) });
    const j = await r.json();
    if (!r.ok) { msg.className = 'msg err'; msg.textContent = j.error || ('error ' + r.status); }
    else { msg.className = 'msg ok'; msg.textContent = 'Saved: ' + (CTX.auras.find(a => a.id === j.aura) || {}).name + ' / ' + (CTX.colossi.find(c => c.id === j.colossus) || {}).name + (j.credits ? ' - and you are in the credits.' : '.') + ' See you in the game!'; }
  } catch (e) { msg.className = 'msg err'; msg.textContent = 'Could not save: ' + e.message; }
  btn.disabled = false;
};
</script></body></html>`;
}

// Step 1: the mod opens this with the player's uuid, name and the one-off Mojang server id. We verify, stash, and bounce to Patreon.
app.get('/link/start', async (req, res) => {
  if (!PATREON_ENABLED) {
    return res.status(503).send(page('Linking not set up', `<div class="big">🗿</div><h1>Patreon linking isn't set up yet</h1>
      <p class="muted">The server owner still needs to add the Patreon app. Try again later, or ask in Discord.</p>`));
  }
  if (limited(req, 'start', 12, 60 * 1000)) return res.status(429).send(page('Slow down', '<h1>Too many attempts</h1><p class="muted">Wait a minute and try again.</p>'));
  const uuid = String(req.query.uuid || '');
  let name = String(req.query.name || '').slice(0, 16);
  const sid = String(req.query.sid || '');
  if (!validUuid(uuid)) return res.status(400).send(page('Bad request', '<h1>Missing or invalid Minecraft UUID</h1>'));
  const uuidRaw = uuid.replace(/-/g, '').toLowerCase();

  let verified = false;
  if (/^[0-9a-f]{16,64}$/i.test(sid) && /^[A-Za-z0-9_]{1,16}$/.test(name)) {
    try {
      const j = await verifyMojangJoin(name, sid);
      if (j && j.uuidRaw === uuidRaw) { verified = true; name = j.name; }
      else console.warn(`[link] Mojang did not confirm ${name} (${uuidRaw})`);
    } catch (e) {
      console.warn('[link] Mojang session check failed:', e.message);
    }
  }
  if (!verified && REQUIRE_MC_VERIFY) {
    return res.status(403).send(page("Couldn't verify your Minecraft account", `<div class="big">🛡️</div><h1>We couldn't confirm that's your Minecraft account</h1>
      <p class="muted">Linking only works from the game, logged in with your Microsoft account (not offline mode), with the current version of the mod.
      Go back to the game and run <code>/wwpatreon</code> again. If it keeps failing, ask in Discord.</p>`));
  }

  pruneStates();
  const state = newState();
  linkStates.set(state, { uuidRaw, uuid: dashUuid(uuid), name, verified, ts: Date.now() });
  const authUrl = 'https://www.patreon.com/oauth2/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: PATREON_CLIENT_ID,
    redirect_uri: PUBLIC_BASE_URL + '/link/callback',
    scope: 'identity identity.memberships',
    state,
  }).toString();
  res.redirect(authUrl);
});

// Step 2: Patreon redirects back here with ?code &state.
app.get('/link/callback', async (req, res) => {
  try {
    if (!PATREON_ENABLED) return res.status(503).send(page('Linking not set up', '<h1>Patreon linking is not configured</h1>'));
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const st = linkStates.get(state);
    if (!code || !st) return res.status(400).send(page('Link expired', '<div class="big">⏳</div><h1>This link expired</h1><p class="muted">Start again from the game with <code>/wwpatreon</code>.</p>'));
    linkStates.delete(state);

    // Exchange the code for an access token
    const tokRes = await fetch('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, grant_type: 'authorization_code',
        client_id: PATREON_CLIENT_ID, client_secret: PATREON_CLIENT_SECRET,
        redirect_uri: PUBLIC_BASE_URL + '/link/callback',
      }).toString(),
    });
    if (!tokRes.ok) throw new Error('token exchange failed (' + tokRes.status + ')');
    const tok = await tokRes.json();

    // Fetch identity + memberships + entitled tiers
    const idUrl = 'https://www.patreon.com/api/oauth2/v2/identity?' + new URLSearchParams({
      include: 'memberships.currently_entitled_tiers',
      'fields[member]': 'patron_status,next_charge_date,last_charge_date',
      'fields[tier]': 'title',
    }).toString();
    const idRes = await fetch(idUrl, { headers: { authorization: 'Bearer ' + tok.access_token } });
    if (!idRes.ok) throw new Error('identity fetch failed (' + idRes.status + ')');
    const id = await idRes.json();

    const patreonUserId = id && id.data && id.data.id ? String(id.data.id) : null;
    const included = Array.isArray(id.included) ? id.included : [];
    const members = included.filter((x) => x.type === 'member');
    const active = members.some((m) => (m.attributes && m.attributes.patron_status) === 'active_patron') || members.length === 0;
    const titles = included.filter((x) => x.type === 'tier').map((t) => t.attributes && t.attributes.title).filter(Boolean);
    const tier = bestTierFromTitles(titles);

    if (!patreonUserId) throw new Error('no Patreon user id');
    if (!tier || !active) {
      // Not an active patron on a mapped tier. If they have paid time left, they keep the perks until it runs out.
      const existing = findByPatreonId(patreonUserId);
      const member = members[0];
      const until = existing && existing.source === 'patreon' ? (existing.expires || paidThrough(member && member.attributes)) : null;
      if (existing && existing.source === 'patreon') {
        if (until && Date.parse(until) > Date.now()) { existing.expires = until; existing.updated = new Date().toISOString(); await saveStore(); }
        else { store.supporters = store.supporters.filter((s) => s !== existing); await saveStore(); }
      }
      const left = until && Date.parse(until) > Date.now()
        ? `<p class="muted">Your pledge has ended, but you paid through <b>${esc(new Date(until).toISOString().slice(0, 10))}</b> - the cosmetics stay until then.</p>` : '';
      return res.status(200).send(page('No active pledge', `<div class="big">🙂</div><h1>No active pledge found</h1>
        <p class="muted">We couldn't find an active Waker / Colossus / Titan pledge on your Patreon. If you just pledged, give it a minute and try again.</p>
        ${left}
        <p class="muted">The tiers are at <a href="${esc(PATREON_URL)}">${esc(PATREON_URL.replace(/^https?:\/\/(www\.)?/, ''))}</a> - every perk is cosmetic; the mod itself is free.</p>`));
    }

    // Detach this Patreon id from any other MC account, then link to this one (keeping a chosen style if the account already had one).
    const prior = findByPatreonId(patreonUserId);
    if (prior && prior.uuidRaw !== st.uuidRaw) { store.supporters = store.supporters.filter((s) => s !== prior); }
    const s = await upsertSupporter({ uuid: st.uuid, name: st.name, tier, extra: { source: 'patreon', patreonUserId, verified: !!st.verified, linkedAt: new Date().toISOString() } });
    console.log(`[patreon] linked ${s.name} (${s.uuid}) tier=${tier} verified=${s.verified}`);

    return res.status(200).send(chooserPage(s, makeToken(s.uuidRaw)));
  } catch (e) {
    console.error('[patreon] callback error:', e.message);
    return res.status(500).send(page('Something went wrong', `<div class="big">⚠️</div><h1>Linking failed</h1><p class="muted">${esc(e.message)}. Please try again from the game.</p>`));
  }
});

// Step 2b: the chooser saves. The token names the account; the tier on file decides what it may wear.
app.post('/link/style', async (req, res) => {
  if (limited(req, 'style', 30, 60 * 1000)) return res.status(429).json({ error: 'too many requests' });
  const uuidRaw = readToken(req.body && req.body.token);
  if (!uuidRaw) return res.status(401).json({ error: 'This page has expired - run /wwpatreon in the game again.' });
  const s = findByUuid(uuidRaw);
  if (!s) return res.status(404).json({ error: 'No supporter record for this account any more.' });
  const aura = String((req.body && req.body.aura) || '').trim().toLowerCase();
  if (!AURA_BY_ID[aura]) return res.status(400).json({ error: 'Unknown aura.' });
  if (!auraAllowed(s.tier, aura)) return res.status(403).json({ error: `${AURA_BY_ID[aura].name} needs the ${tierNeeded(AURA_BY_ID[aura].rank)} tier.` });
  const colossus = String((req.body && req.body.colossus) || s.style.colossus || 'none').trim().toLowerCase();
  if (!COLOSSUS_BY_ID[colossus]) return res.status(400).json({ error: 'Unknown colossus style.' });
  if (!colossusAllowed(s.tier, colossus)) return res.status(403).json({ error: `${COLOSSUS_BY_ID[colossus].name} needs the ${tierNeeded(COLOSSUS_BY_ID[colossus].rank)} tier.` });
  s.style.aura = aura;
  s.style.colossus = colossus;
  s.credits = !!(req.body && req.body.credits === true);
  s.updated = new Date().toISOString();
  await saveStore();
  console.log(`[style] ${s.name} (${s.uuid}) aura=${aura} colossus=${colossus} credits=${s.credits}`);
  res.json({ ok: true, aura: s.style.aura, colossus: s.style.colossus, credits: s.credits });
});

// From the game: read or change one's own cosmetics. The client first "joins" a one-off server id at Mojang and
// sends it along; we ask Mojang whether this account really did (proof of ownership), then the tier on file decides.
//   POST /api/me/cosmetics  { uuid, name, sid, aura?, colossus? }  ->  { ok, tier, aura, colossus, unlocked }
app.post('/api/me/cosmetics', async (req, res) => {
  if (limited(req, 'me', 20, 60 * 1000)) return res.status(429).json({ error: 'Too many requests - wait a minute.' });
  const b = req.body || {};
  const uuid = String(b.uuid || '');
  const name = String(b.name || '').slice(0, 16);
  const sid = String(b.sid || '');
  if (!validUuid(uuid)) return res.status(400).json({ error: 'Invalid Minecraft UUID.' });
  const uuidRaw = uuid.replace(/-/g, '').toLowerCase();
  let verified = false;
  if (/^[0-9a-f]{16,64}$/i.test(sid) && /^[A-Za-z0-9_]{1,16}$/.test(name)) {
    try {
      const j = await verifyMojangJoin(name, sid);
      verified = !!(j && j.uuidRaw === uuidRaw);
    } catch (e) {
      console.warn('[me] Mojang session check failed:', e.message);
      return res.status(502).json({ error: 'Could not reach Mojang to confirm your account - try again in a moment.' });
    }
  }
  if (!verified && REQUIRE_MC_VERIFY) return res.status(403).json({ error: "Mojang couldn't confirm your account (offline mode?). Log in with your Microsoft account and try again." });
  sweepExpired();
  const s = findByUuid(uuidRaw);
  if (!s) return res.status(404).json({ error: 'This Minecraft account is not linked to a Patreon yet - run /wwpatreon to link it.' });
  let changed = false;
  if (typeof b.aura === 'string' && b.aura.trim()) {
    const aura = b.aura.trim().toLowerCase();
    if (!AURA_BY_ID[aura]) return res.status(400).json({ error: 'Unknown aura: ' + aura });
    if (!auraAllowed(s.tier, aura)) return res.status(403).json({ error: `${AURA_BY_ID[aura].name} needs the ${tierNeeded(AURA_BY_ID[aura].rank)} tier.` });
    s.style.aura = aura; changed = true;
  }
  if (typeof b.colossus === 'string' && b.colossus.trim()) {
    const colossus = b.colossus.trim().toLowerCase();
    if (!COLOSSUS_BY_ID[colossus]) return res.status(400).json({ error: 'Unknown colossus style: ' + colossus });
    if (!colossusAllowed(s.tier, colossus)) return res.status(403).json({ error: `${COLOSSUS_BY_ID[colossus].name} needs the ${tierNeeded(COLOSSUS_BY_ID[colossus].rank)} tier.` });
    s.style.colossus = colossus; changed = true;
  }
  if (typeof b.credits === 'boolean') { s.credits = b.credits; changed = true; } // the Hall of Wakers: their name, their call
  if (changed) {
    s.updated = new Date().toISOString();
    await saveStore();
    console.log(`[me] ${s.name} (${s.uuid}) aura=${s.style.aura} colossus=${s.style.colossus} credits=${s.credits}`);
  }
  res.json({ ok: true, ...publicEntry(s), credits: !!s.credits, name: s.name, expires: s.expires || null });
});

// Step 3: Patreon webhook keeps tiers in sync (pledge create/update/delete).
app.post('/webhook/patreon', async (req, res) => {
  try {
    if (!PATREON_WEBHOOK_SECRET) return res.status(503).json({ error: 'webhook not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = req.get('X-Patreon-Signature') || '';
    const expected = crypto.createHmac('md5', PATREON_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!sig || !safeEqual(sig, expected)) {
      console.warn(`[patreon] webhook REJECTED bad signature (event=${req.get('X-Patreon-Event') || '?'}, bytes=${raw.length})`);
      return res.status(401).json({ error: 'bad signature' });
    }

    const trigger = req.get('X-Patreon-Event') || '';
    console.log(`[patreon] webhook OK event=${trigger} bytes=${raw.length}`);
    const body = JSON.parse(raw.toString('utf8'));
    const data = body.data || {};
    const included = Array.isArray(body.included) ? body.included : [];
    const patreonUserId = data.relationships && data.relationships.user && data.relationships.user.data ? String(data.relationships.user.data.id) : null;
    const patronStatus = data.attributes && data.attributes.patron_status;
    const titles = included.filter((x) => x.type === 'tier').map((t) => t.attributes && t.attributes.title).filter(Boolean);
    const tier = bestTierFromTitles(titles);

    if (!patreonUserId) return res.status(200).json({ ok: true, note: 'no user id' });
    const existing = findByPatreonId(patreonUserId);

    // With members:update on, a payload can arrive that simply does not mention tiers. Only treat "no tier"
    // as the end of a pledge when the payload actually told us what they are entitled to.
    const rel = data.relationships && data.relationships.currently_entitled_tiers;
    const tiersKnown = !!(rel && Array.isArray(rel.data)) || included.some((x) => x.type === 'tier');
    const ended = trigger.includes('delete') || patronStatus === 'former_patron' || (tiersKnown && !tier);
    if (!ended && !tier) return res.status(200).json({ ok: true, note: 'no tier in payload - ignored' });

    if (ended) {
      if (existing && existing.source === 'patreon') {
        // They keep what they paid for: the perks run to the end of the period, then the sweep drops them.
        // A failed payment (Patreon retries for about a week) buys the same kind of grace.
        const grace = patronStatus === 'declined_patron' ? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() : null;
        const paid = paidThrough(data.attributes);
        const until = grace && (!paid || grace > paid) ? grace : paid;
        if (until) {
          existing.expires = until;
          existing.updated = new Date().toISOString();
          await saveStore();
          console.log(`[patreon] ${existing.name} (${existing.uuid}) pledge ended - perks run until ${until}`);
          return res.status(200).json({ ok: true, action: 'expires', expires: until });
        }
        store.supporters = store.supporters.filter((s) => s !== existing);
        await saveStore();
      }
      return res.status(200).json({ ok: true, action: 'removed' });
    }
    if (existing) {
      existing.tier = tier;
      delete existing.expires; // pledging again cancels a pending end date
      existing.updated = new Date().toISOString();
      normalizeSupporter(existing); // a lowered tier loses auras it no longer unlocks
      await saveStore();
      return res.status(200).json({ ok: true, action: 'updated', tier });
    }
    // No prior MC link for this patron yet (they pledged but haven't linked in-game): nothing to apply.
    return res.status(200).json({ ok: true, note: 'no linked MC account yet' });
  } catch (e) {
    console.error('[patreon] webhook error:', e.message);
    return res.status(200).json({ ok: false }); // 200 so Patreon doesn't hammer retries on our parse errors
  }
});

// ---------- admin ----------
app.get('/api/supporters', requireAdmin, (req, res) => res.json({ updated: store.updated, auras: AURAS, colossi: COLOSSI, supporters: store.supporters }));

app.post('/api/supporters', requireAdmin, async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const tier = (req.body && req.body.tier ? String(req.body.tier) : '').trim().toLowerCase();
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim().slice(0, 200);
  if (!/^[A-Za-z0-9_]{2,16}$/.test(name)) return res.status(400).json({ error: 'invalid Minecraft username' });
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'tier must be one of: ' + TIERS.join(', ') });
  let profile;
  try { profile = await resolveMojang(name); }
  catch (e) { return res.status(502).json({ error: 'could not reach Mojang: ' + e.message }); }
  if (!profile) return res.status(404).json({ error: 'no Minecraft account named "' + name + '"' });
  const s = await upsertSupporter({ uuid: profile.uuid, name: profile.name, tier, extra: { note, source: 'manual', verified: true } });
  console.log(`[admin] upsert ${profile.name} (${profile.uuid}) tier=${tier}`);
  res.json({ ok: true, supporter: { uuid: s.uuid, name: s.name, tier: s.tier, aura: s.style.aura } });
});

// Admin: set a supporter's aura / credits by hand (same tier check as the chooser).
app.patch('/api/supporters/:key', requireAdmin, async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const s = store.supporters.find((x) => x.uuid.toLowerCase() === key || x.uuidRaw === key || (x.name || '').toLowerCase() === key);
  if (!s) return res.status(404).json({ error: 'no supporter matched "' + req.params.key + '"' });
  if (req.body && typeof req.body.aura === 'string') {
    const aura = req.body.aura.trim().toLowerCase();
    if (!AURA_BY_ID[aura]) return res.status(400).json({ error: 'unknown aura' });
    if (!auraAllowed(s.tier, aura)) return res.status(403).json({ error: 'that aura is above this supporter\'s tier' });
    s.style.aura = aura;
  }
  if (req.body && typeof req.body.colossus === 'string') {
    const c = req.body.colossus.trim().toLowerCase();
    if (!COLOSSUS_BY_ID[c]) return res.status(400).json({ error: 'unknown colossus style' });
    if (!colossusAllowed(s.tier, c)) return res.status(403).json({ error: 'that colossus style is above this supporter\'s tier' });
    s.style.colossus = c;
  }
  if (req.body && typeof req.body.credits === 'boolean') s.credits = req.body.credits;
  s.updated = new Date().toISOString();
  await saveStore();
  res.json({ ok: true, supporter: { uuid: s.uuid, name: s.name, tier: s.tier, aura: s.style.aura, colossus: s.style.colossus, credits: s.credits } });
});

// Admin: see the chooser page as a given supporter would (the token it carries is real, so saves from it apply).
app.get('/api/chooser/:key', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const s = store.supporters.find((x) => x.uuid.toLowerCase() === key || x.uuidRaw === key || (x.name || '').toLowerCase() === key);
  if (!s) return res.status(404).send(page('Not found', '<h1>No such supporter</h1>'));
  res.send(chooserPage(s, makeToken(s.uuidRaw)));
});

app.delete('/api/supporters/:key', requireAdmin, async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const before = store.supporters.length;
  store.supporters = store.supporters.filter((s) => !(s.uuid.toLowerCase() === key || s.uuidRaw.toLowerCase() === key || (s.name || '').toLowerCase() === key));
  if (store.supporters.length === before) return res.status(404).json({ error: 'no supporter matched "' + req.params.key + '"' });
  await saveStore();
  console.log(`[admin] removed ${req.params.key}`);
  res.json({ ok: true, removed: before - store.supporters.length });
});

// Admin UI + static (serve admin.html at "/")
app.use(express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));

loadStore().then(() => {
  setInterval(sweepExpired, 60 * 60 * 1000).unref?.(); // ended pledges fall off on their own
  app.listen(PORT, () => console.log(`[lovkar-supporters] listening on :${PORT}  (data ${DATA_FILE}, patreon ${PATREON_ENABLED ? 'ON' : 'OFF'}, mc-verify ${REQUIRE_MC_VERIFY ? 'ON' : 'OFF'})`));
});
