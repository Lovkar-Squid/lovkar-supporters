'use strict';

/*
 * lovkar-supporters
 * Holds the list of Patreon supporters for Lovkar's Minecraft mods and serves it
 * so the mods can grant COSMETIC-ONLY in-game perks.
 *
 * Public:
 *   GET  /supporters.json     -> { updated, supporters: [ { uuid, name, tier } ] }
 *   GET  /healthz             -> { ok, count, patreon }
 *   GET  /link/start          -> begins Patreon linking (mod opens this in a browser)
 *   GET  /link/callback       -> Patreon OAuth callback (stores UUID<->tier)
 *   POST /webhook/patreon      -> Patreon webhook, HMAC-verified, auto-syncs tiers
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

// --- Patreon config (all optional; linking is disabled until these are set) ---
const PATREON_CLIENT_ID = process.env.PATREON_CLIENT_ID || '';
const PATREON_CLIENT_SECRET = process.env.PATREON_CLIENT_SECRET || '';
const PATREON_WEBHOOK_SECRET = process.env.PATREON_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://supporters.lovkarsquid.com').replace(/\/+$/, '');
// Map a Patreon tier TITLE (lower-cased) to our key. Titles: Waker / Colossus / Titan.
const TITLE_TO_TIER = { waker: 'waker', colossus: 'colossus', titan: 'titan' };

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error('[fatal] ADMIN_TOKEN env var is required and must be at least 12 characters.');
  process.exit(1);
}
const PATREON_ENABLED = !!(PATREON_CLIENT_ID && PATREON_CLIENT_SECRET);

// ---------- storage ----------
function emptyStore() {
  return { updated: new Date().toISOString(), supporters: [] };
}
let store = emptyStore();

async function loadStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.supporters)) {
      store = parsed;
      console.log(`[data] loaded ${store.supporters.length} supporter(s) from ${DATA_FILE}`);
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

async function resolveMojang(name) {
  const url = 'https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error('Mojang API returned ' + r.status);
    const j = await r.json();
    if (!j || !j.id) return null;
    return { uuidRaw: j.id.toLowerCase(), uuid: dashUuid(j.id), name: j.name };
  } finally { clearTimeout(t); }
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

// Upsert a supporter identified by Minecraft uuid. Extra fields merged in.
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
  await saveStore();
  return s;
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);

// Raw body ONLY for the Patreon webhook (needed for HMAC); JSON for everything else.
app.use('/webhook/patreon', express.raw({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '64kb' }));

// ---- public list the mods fetch ----
app.get('/supporters.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ updated: store.updated, supporters: store.supporters.map((s) => ({ uuid: s.uuid, name: s.name, tier: s.tier })) });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, count: store.supporters.length, updated: store.updated, patreon: PATREON_ENABLED });
});

// ---------- Patreon linking ----------
const linkStates = new Map(); // state -> { uuidRaw, uuid, name, ts }
function newState() { return crypto.randomBytes(24).toString('base64url'); }
function pruneStates() { const cutoff = Date.now() - 10 * 60 * 1000; for (const [k, v] of linkStates) if (v.ts < cutoff) linkStates.delete(k); }

function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#0b0e12;color:#e8edf2;font:16px/1.6 system-ui,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:520px;padding:34px;background:#141a21;border:1px solid #232d38;border-radius:14px;text-align:center;margin:20px}
h1{margin:0 0 10px;font-size:22px}.t{font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.waker{color:#39ff14}.colossus{color:#ff9628}.titan{color:#be5aff}.muted{color:#8a97a6}.big{font-size:40px;margin-bottom:6px}</style>
</head><body><div class="card">${bodyHtml}</div></body></html>`;
}

// Step 1: the mod opens this with the player's uuid (+ name). We stash it and bounce to Patreon.
app.get('/link/start', (req, res) => {
  if (!PATREON_ENABLED) {
    return res.status(503).send(page('Linking not set up', `<div class="big">🗿</div><h1>Patreon linking isn't set up yet</h1>
      <p class="muted">The server owner still needs to add the Patreon app. Try again later, or ask in Discord.</p>`));
  }
  const uuid = String(req.query.uuid || '');
  const name = String(req.query.name || '').slice(0, 16);
  if (!validUuid(uuid)) return res.status(400).send(page('Bad request', '<h1>Missing or invalid Minecraft UUID</h1>'));
  pruneStates();
  const state = newState();
  linkStates.set(state, { uuidRaw: uuid.replace(/-/g, '').toLowerCase(), uuid: dashUuid(uuid), name, ts: Date.now() });
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
    if (!code || !st) return res.status(400).send(page('Link expired', '<div class="big">⏳</div><h1>This link expired</h1><p class="muted">Start again from the game.</p>'));
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
      'fields[member]': 'patron_status',
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
      // Not an active patron on a mapped tier - make sure they aren't listed via Patreon.
      const existing = findByPatreonId(patreonUserId);
      if (existing && existing.source === 'patreon') { store.supporters = store.supporters.filter((s) => s !== existing); await saveStore(); }
      return res.status(200).send(page('No active pledge', `<div class="big">🙂</div><h1>No active pledge found</h1>
        <p class="muted">We couldn't find an active Waker / Colossus / Titan pledge on your Patreon. If you just pledged, give it a minute and try again.</p>`));
    }

    // Detach this Patreon id from any other MC account, then link to this one.
    const prior = findByPatreonId(patreonUserId);
    if (prior && prior.uuidRaw !== st.uuidRaw) { store.supporters = store.supporters.filter((s) => s !== prior); }
    const s = await upsertSupporter({ uuid: st.uuid, name: st.name, tier, extra: { source: 'patreon', patreonUserId, linkedAt: new Date().toISOString() } });

    return res.status(200).send(page('Linked!', `<div class="big">🗿</div><h1>Linked — welcome, <span class="t ${s.tier}">${s.tier}</span>!</h1>
      <p>Your Minecraft account <b>${s.name || s.uuid}</b> is now connected to your Patreon.</p>
      <p class="muted">Your in-game perks will appear shortly. You can close this tab and return to the game.</p>`));
  } catch (e) {
    console.error('[patreon] callback error:', e.message);
    return res.status(500).send(page('Something went wrong', `<div class="big">⚠️</div><h1>Linking failed</h1><p class="muted">${e.message}. Please try again from the game.</p>`));
  }
});

// Step 3: Patreon webhook keeps tiers in sync (pledge create/update/delete).
app.post('/webhook/patreon', async (req, res) => {
  try {
    if (!PATREON_WEBHOOK_SECRET) return res.status(503).json({ error: 'webhook not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = req.get('X-Patreon-Signature') || '';
    const expected = crypto.createHmac('md5', PATREON_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!sig || !safeEqual(sig, expected)) return res.status(401).json({ error: 'bad signature' });

    const trigger = req.get('X-Patreon-Event') || '';
    const body = JSON.parse(raw.toString('utf8'));
    const data = body.data || {};
    const included = Array.isArray(body.included) ? body.included : [];
    const patreonUserId = data.relationships && data.relationships.user && data.relationships.user.data ? String(data.relationships.user.data.id) : null;
    const patronStatus = data.attributes && data.attributes.patron_status;
    const titles = included.filter((x) => x.type === 'tier').map((t) => t.attributes && t.attributes.title).filter(Boolean);
    const tier = bestTierFromTitles(titles);

    if (!patreonUserId) return res.status(200).json({ ok: true, note: 'no user id' });
    const existing = findByPatreonId(patreonUserId);

    if (trigger.includes('delete') || patronStatus === 'former_patron' || !tier) {
      if (existing && existing.source === 'patreon') { store.supporters = store.supporters.filter((s) => s !== existing); await saveStore(); }
      return res.status(200).json({ ok: true, action: 'removed' });
    }
    if (existing) { existing.tier = tier; existing.updated = new Date().toISOString(); await saveStore(); return res.status(200).json({ ok: true, action: 'updated', tier }); }
    // No prior MC link for this patron yet (they pledged but haven't linked in-game): nothing to apply.
    return res.status(200).json({ ok: true, note: 'no linked MC account yet' });
  } catch (e) {
    console.error('[patreon] webhook error:', e.message);
    return res.status(200).json({ ok: false }); // 200 so Patreon doesn't hammer retries on our parse errors
  }
});

// ---------- admin ----------
app.get('/api/supporters', requireAdmin, (req, res) => res.json({ updated: store.updated, supporters: store.supporters }));

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
  const s = await upsertSupporter({ uuid: profile.uuid, name: profile.name, tier, extra: { note, source: 'manual' } });
  console.log(`[admin] upsert ${profile.name} (${profile.uuid}) tier=${tier}`);
  res.json({ ok: true, supporter: { uuid: s.uuid, name: s.name, tier: s.tier } });
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
  app.listen(PORT, () => console.log(`[lovkar-supporters] listening on :${PORT}  (data ${DATA_FILE}, patreon ${PATREON_ENABLED ? 'ON' : 'OFF'})`));
});
