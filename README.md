# lovkar-supporters

A tiny self-hosted service that holds the list of Patreon supporters for
**Lovkar's Minecraft mods** and serves it so the mods can grant **cosmetic-only**
in-game perks (a supporter aura, a name in the credits, etc.).

It is deliberately small: one Minecraft name, its UUID and a Patreon tier per
supporter. No gameplay data, nothing pay-to-win.

## Endpoints

Public (what the mods fetch):

- `GET /supporters.json` → `{ "updated": "...", "supporters": [ { "uuid", "name", "tier" } ] }`
- `GET /healthz` → `{ "ok": true, "count": N }`

Admin (needs the header `x-admin-token: <ADMIN_TOKEN>`, or `?token=`):

- `GET /` → admin web page (enter the token once, then add/remove supporters)
- `GET /api/supporters` → full list
- `POST /api/supporters` → body `{ "name": "<MC username>", "tier": "waker|colossus|titan", "note": "" }`
  (the service resolves the UUID from Mojang automatically)
- `DELETE /api/supporters/:key` → remove by uuid or name

Data is stored in `/data/supporters.json` on a Docker volume, so it survives
container recreation.

## Run it (Docker Compose)

```bash
git clone https://github.com/Lovkar-Squid/lovkar-supporters
cd lovkar-supporters
cp .env.example .env
# edit .env: set ADMIN_TOKEN (any long random string) and, once you have it,
# the Cloudflare TUNNEL_TOKEN
docker compose up -d --build
```

`docker-compose.yml` starts two containers:

- `lovkar-supporters` – the API (internal port 8080)
- `cloudflared` – a Cloudflare Tunnel that publishes it at
  `https://supporters.lovkarsquid.com` (routing configured in the Cloudflare
  Zero Trust dashboard to `http://lovkar-supporters:8080`)

## Tiers

`waker`, `colossus`, `titan`. The free tier gets no in-game perk, so it is not
listed here.

Made by **Lovkar & Claude**.
