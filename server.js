'use strict';

/*
 * lovkar-supporters
 * A tiny HTTP service that holds the list of Patreon supporters for Lovkar's
 * Minecraft mods and serves it so the mods can grant COSMETIC-ONLY in-game perks.
 *
 * Public:
 *   GET /supporters.json     -> { updated, supporters: [ { uuid, name, tier } ] }
 *   GET /healthz             -> { ok, count }
 *
 * Admin (require header  x-admin-token: <ADMIN_TOKEN>  or ?token=):
 *   GET    /api/supporters        -> full list (with notes / timestamps)
 *   POST   /api/supporters        -> { name, tier, note? }  (resolves UUID from Mojang)
 *   DELETE /api/supporters/:key   -> remove by uuid (dashed or raw) or by name
 *   GET    /                      -> admin web UI (public/admin.html)
 *
 * Data is a single JSON file under DATA_DIR (a Docker volume), written atomically.
 * No gameplay data here on purpose: only a Minecraft name, its UUID and a tier.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'supporters.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TIERS = ['waker', 'colossus', 'titan']; // free tier ("watcher") gets no in-game perk

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error('[fatal] ADMIN_TOKEN env var is required and must be at least 12 characters.');
  process.exit(1);
}

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
    if (err.code === 'ENOENT') {
      console.log('[data] no file yet - starting empty');
    } else {
      console.warn('[data] could not read store:', err.message, '- starting empty');
    }
  }
  await saveStore();
}

let saving = Promise.resolve();
async function saveStore() {
  store.updated = new Date().toISOString();
  // serialise writes so two requests never interleave
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
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
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

// Resolve a Minecraft username to a UUID via Mojang's public API.
async function resolveMojang(name) {
  const url = 'https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error('Mojang API returned ' + r.status);
    const j = await r.json();
    if (!j || !j.id) return null;
    return { uuidRaw: j.id, uuid: dashUuid(j.id), name: j.name };
  } finally {
    clearTimeout(t);
  }
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

// Public list the mods fetch. Cosmetic data only.
app.get('/supporters.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    updated: store.updated,
    supporters: store.supporters.map((s) => ({ uuid: s.uuid, name: s.name, tier: s.tier })),
  });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, count: store.supporters.length, updated: store.updated });
});

// Admin: full view
app.get('/api/supporters', requireAdmin, (req, res) => {
  res.json({ updated: store.updated, supporters: store.supporters });
});

// Admin: add / update a supporter by Minecraft username
app.post('/api/supporters', requireAdmin, async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const tier = (req.body && req.body.tier ? String(req.body.tier) : '').trim().toLowerCase();
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim().slice(0, 200);

  if (!/^[A-Za-z0-9_]{2,16}$/.test(name)) {
    return res.status(400).json({ error: 'invalid Minecraft username' });
  }
  if (!TIERS.includes(tier)) {
    return res.status(400).json({ error: 'tier must be one of: ' + TIERS.join(', ') });
  }

  let profile;
  try {
    profile = await resolveMojang(name);
  } catch (e) {
    return res.status(502).json({ error: 'could not reach Mojang: ' + e.message });
  }
  if (!profile) {
    return res.status(404).json({ error: 'no Minecraft account named "' + name + '"' });
  }

  const now = new Date().toISOString();
  const existing = store.supporters.find((s) => s.uuidRaw === profile.uuidRaw);
  if (existing) {
    existing.name = profile.name;
    existing.tier = tier;
    existing.note = note;
    existing.updated = now;
  } else {
    store.supporters.push({
      uuid: profile.uuid,
      uuidRaw: profile.uuidRaw,
      name: profile.name,
      tier,
      note,
      added: now,
      updated: now,
    });
  }
  await saveStore();
  console.log(`[admin] upsert ${profile.name} (${profile.uuid}) tier=${tier}`);
  res.json({ ok: true, supporter: { uuid: profile.uuid, name: profile.name, tier } });
});

// Admin: remove by uuid (dashed or raw) or by name
app.delete('/api/supporters/:key', requireAdmin, async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const before = store.supporters.length;
  store.supporters = store.supporters.filter((s) => {
    return !(s.uuid.toLowerCase() === key || s.uuidRaw.toLowerCase() === key || s.name.toLowerCase() === key);
  });
  if (store.supporters.length === before) {
    return res.status(404).json({ error: 'no supporter matched "' + req.params.key + '"' });
  }
  await saveStore();
  console.log(`[admin] removed ${req.params.key}`);
  res.json({ ok: true, removed: before - store.supporters.length });
});

// Admin UI + static
app.use(express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));

loadStore().then(() => {
  app.listen(PORT, () => {
    console.log(`[lovkar-supporters] listening on :${PORT}  (data at ${DATA_FILE})`);
  });
});
