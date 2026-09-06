# lovkar-supporters

A tiny self-hosted service that holds the list of Patreon supporters for
**Lovkar's Minecraft mods** and serves it so the mods can grant **cosmetic-only**
in-game perks (a supporter aura, a name in the credits, etc.).

It is deliberately small: one Minecraft account, its Patreon tier and the
cosmetic it chose per supporter. No gameplay data, nothing pay-to-win.

## How linking works

1. In the game a supporter runs `/wwpatreon`. The mod first tells Mojang's
   session server it is "joining" a one-off server id (the same handshake
   every multiplayer login does), then opens `/link/start` in the browser.
2. The service asks Mojang whether that account really did join that id -
   **proof the linker owns the Minecraft account** - and only then sends them
   to Patreon to log in (OAuth, scopes `identity identity.memberships`).
3. Patreon sends them back to `/link/callback`; the service reads the
   entitled tier (by tier *title*: Waker / Colossus / Titan), stores
   UUID ↔ tier, and shows the **chooser page**: the auras that tier unlocks
   (higher tiers see the lower tiers' auras too, locked ones are shown but
   cannot be picked), plus an opt-in to be listed in the public credits.
4. A Patreon webhook (`members:pledge:create/update/delete`, HMAC-MD5
   verified) keeps tiers in sync afterwards; a lowered tier loses any aura it
   no longer unlocks.

The service is the only place a cosmetic is decided and checked. The mod has
the service address compiled in, never lets a client pick for itself, and only
draws what the list says.

## Endpoints

Public (what the mods fetch):

- `GET /supporters.json` →
  `{ "v": 2, "updated": "...", "salt": "...", "supporters": [ { "h", "tier", "aura", "colossus" } ] }`
  where `h = sha256(salt + ":" + uuid)` (lower-case, dashed uuid). The list
  names nobody: a mod hashes the players it meets and looks them up.
- `GET /credits.json` → `{ "credits": { "titan": [names], "colossus": [...], "waker": [...] } }`
  - only supporters who ticked the credits box.
- `GET /healthz` → `{ "ok": true, "count": N, "patreon": true|false, "verify": true|false }`
- `GET /link/start?uuid=&name=&sid=` → verifies with Mojang, redirects to Patreon
- `GET /link/callback` → Patreon OAuth callback, then the chooser page
- `POST /link/style` → `{ token, aura, colossus, credits }` from the chooser page
  (the token is signed and short-lived; every choice is checked against the tier)
- `POST /api/me/cosmetics` → `{ uuid, name, sid, aura?, colossus?, credits? }` from the game
  (`/wwpatreon aura <name>`, `/wwpatreon colossus <name>`, `/wwpatreon credits on|off`,
  `/wwpatreon status`): Mojang confirms the account via `sid`, the tier on file decides;
  answers the current entry, the credits flag and what is unlocked
- `POST /webhook/patreon` → Patreon webhook

Admin (needs the header `x-admin-token: <ADMIN_TOKEN>`, or `?token=`):

- `GET /` → admin web page (enter the token once; add/remove supporters, set
  an aura from the dropdown, tick credits)
- `GET /api/supporters` → full list (+ the aura catalogue)
- `POST /api/supporters` → body `{ "name": "<MC username>", "tier": "waker|colossus|titan", "note": "" }`
  (the service resolves the UUID from Mojang automatically)
- `PATCH /api/supporters/:key` → `{ "aura": "...", "colossus": "...", "credits": true|false }`
- `DELETE /api/supporters/:key` → remove by uuid or name
- `GET /api/chooser/:key` → the chooser page as that supporter would see it

Data is stored in `/data/supporters.json` on a Docker volume, so it survives
container recreation.

## Auras

| id | unlocked by | what it is |
| --- | --- | --- |
| `none` | everyone | no aura |
| `waker` | Waker | soft green glyphs rising round the feet |
| `colossus` | Colossus | glyphs orbiting the feet + a ring of light every few seconds (orange) |
| `stone` `earth` `sandstone` `ice` `prismarine` `moss` | Colossus | the same sigil in the six lands' colours |
| `titan` | Titan | the sigil in void purple, a twin pulse, embers |
| `crown` | Titan | a halo of gold glyphs above the head, shedding embers |

The catalogue is mirrored in the mod (`AuraStyle.java`); the service decides,
the mod draws.

## Colossus styles

The giants a supporter's rites wake rise dressed in the style they chose - the
same shape and hit boxes, other blocks and glow. The Titan is never dressed.

| id | unlocked by | what it is |
| --- | --- | --- |
| `none` | everyone | the land's own stone |
| `sentinel` | Colossus | blackstone and iron, sea-lantern seams at the joints, a visor |
| `eldest` | Colossus | deepslate with gold-lit carvings and a little moss |
| `seraph` | Titan | white quartz plating, crying-obsidian light along the edges, a visor, lit horns |

Mirrored in the mod as `ColossusStyle.java`.

## Run it (Docker Compose)

```bash
git clone https://github.com/Lovkar-Squid/lovkar-supporters
cd lovkar-supporters
cp .env.example .env
# edit .env: set ADMIN_TOKEN (any long random string), the Cloudflare
# TUNNEL_TOKEN, and the Patreon client id / secret / webhook secret
docker compose up -d --build
```

`docker-compose.yml` starts two containers:

- `lovkar-supporters` – the API (internal port 8080)
- `cloudflared` – a Cloudflare Tunnel that publishes it at
  `https://supporters.lovkarsquid.com` (routing configured in the Cloudflare
  Zero Trust dashboard to `http://lovkar-supporters:8080`)

Optional environment: `REQUIRE_MC_VERIFY=0` turns the Mojang ownership check
off (offline development only); `LINK_SECRET` pins the key that signs the
chooser tokens (random per start otherwise - tokens live 30 minutes anyway).
`PATREON_URL` is the public Patreon page the link pages point at (default
https://www.patreon.com/Lovkar).

## Tiers

`waker`, `colossus`, `titan`. The free tier gets no in-game perk, so it is not
listed here.

Made by **Lovkar & Claude**.
