# AirWave

**One-way live audio broadcast for the web.** One person talks; everyone else
listens live on their phones — and the audio **keeps playing when the screen is
off or the app is in the background**, because listeners receive plain HLS media.

Built to run anywhere Docker runs, exposed over HTTPS with a Cloudflare tunnel —
**no public IP required**.

---

## Features

- 🎙️ **One broadcaster → unlimited listeners**, all in sync.
- 📻 **Background / locked-screen playback** on iOS and Android (HLS, not WebRTC).
- ⚡ **~1.5s latency** on a good network, with **continuity-first adaptive latency**:
  slow connections fall behind and catch up instead of dropping audio.
- 🎛️ **Mixer / Dante line input** — feed a professional program mix, not just a mic.
- ⏺️ **Optional per-session recording** → downloadable MP3 archive.
- 💬 **Free live captions** (broadcaster's browser, relayed to listeners).
- 🔒 **Password-gated, unlisted broadcasting** — the talk page is reachable by
  direct URL only and requires a password (enforced server-side).
- 🔑 **Optional private listening** — a secret-link key (set in `.env`) gates the
  audio itself (`/listen?k=…`), with a **QR code** on the broadcaster page.
- ☁️ **No public IP** — runs behind a Cloudflare quick or named tunnel.

---

## How it works

```
 Broadcaster browser                         Node + ffmpeg server                 Listeners
 ┌───────────────────┐   Opus/WebM over WS   ┌──────────────────────┐   HLS      ┌──────────────┐
 │ mic / mixer / Dante│ ────────────────────▶│ ffmpeg → HLS segments │──────────▶│ phones (hls.js│
 │ (MediaRecorder)    │                       │ + MP3 recording       │  over HTTP │ / native iOS) │
 └───────────────────┘   status + captions   └──────────────────────┘            └──────────────┘
                          (WebSocket)                    │
                                                  Cloudflare tunnel (HTTPS, no public IP)
```

- **[server.js](server.js)** — serves the pages, accepts the broadcaster's audio
  over a WebSocket, pipes it through **ffmpeg** into rolling HLS segments (and an
  optional MP3), serves everything over HTTP, and tracks live state + listener
  count. Includes a heartbeat that reclaims dead broadcaster sessions.
- **[public/broadcast.html](public/broadcast.html)** — mic/line capture, password
  login, live captions, recording toggle.
- **[public/listen.html](public/listen.html)** — HLS playback (hls.js, native iOS
  fallback), adaptive latency, captions, lock-screen controls.

Media never round-trips through a third-party SFU; the tunnel only carries HTTP.

---

## Quick start

Requires **Docker** (the image bundles ffmpeg).

```bash
cp .env.example .env      # set BROADCAST_PASSWORD (and TUNNEL_TOKEN if using a named tunnel)
docker compose up -d --build
```

- **Listeners:** open `/listen`
- **Broadcaster:** open `/broadcast` (direct URL), enter the password, pick an
  input, and click **Go live**.

### Local only

The app listens on `http://localhost:8080`. To run just the app without a tunnel:

```bash
docker compose up -d --build app
```

---

## Going public (Cloudflare tunnel)

**Named tunnel (stable URL on your domain) — recommended.**
1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel**, copy the
   token into `TUNNEL_TOKEN` in `.env`.
2. Add a **Public Hostname** on that tunnel → Service **`http://app:8080`**.
3. `docker compose up -d --build`.

**Quick tunnel (throwaway URL, no domain/token).** Switch the `tunnel` service to
the quick-tunnel command shown in [docker-compose.yml](docker-compose.yml), then
read the URL from `docker compose logs tunnel`.

> The whole app is HTTP/WebSocket only, so the tunnel needs no special ports and
> no public IP.

---

## Feeding a mixer / Dante

The broadcaster captures any OS audio **input device**:

- **Dante:** a **Dante AVIO "Dante → USB"** adapter (or any Dante interface with
  a USB/analog output) appears as a plug-and-play USB audio device — **no driver
  or Dante Virtual Soundcard license**. Route your program mix to it in Dante
  Controller, then select it in the Microphone dropdown.
- Tick **"Line input (mixer / Dante — no mic processing)"** before going live to
  disable echo-cancellation / noise-suppression / auto-gain (these are for voice
  and would degrade a clean mix) and raise the ingest bitrate.
- With auto-gain off, set level at the mixer (peaks around −6 dBFS). Send mono
  program to both channels so listeners hear it centered.

---

## Private listening (secret link)

By default anyone with the link can listen. To make it private, set `LISTEN_KEY`
in `.env` to any random string, then `docker compose up -d`:

- The listener link becomes **`/listen?k=<key>`**, and the **audio endpoints
  (`/hls/*`) and the status/caption feed are gated** by it — not just the page.
  The key is stored as a cookie so hls.js and native iOS playback stay authorized.
- The broadcaster page shows the keyed link **and a QR code** to scan/share.
- **`.env` is the single source of truth.** To rotate/revoke, change `LISTEN_KEY`
  and redeploy — all old links/QRs stop working.
- Leave `LISTEN_KEY` empty for a fully public broadcast (no key anywhere).

> This is an unguessable, revocable link — frictionless for QR/scan-to-listen —
> but a shared link can be forwarded. For per-person access control, put
> **Cloudflare Access** in front of the tunnel instead.

## Recording

Opt-in per session: the broadcaster ticks **"Record this broadcast"** before going
live. A full **MP3** is written and appears at **`/recordings`** for download
(files served from `/rec/...`). The MP3 stays valid even if the broadcast ends
abruptly. Set `RECORD=0` in `.env` to disable the feature entirely.

---

## Live captions

Opt-in (**"Live captions"** checkbox). Uses the broadcaster browser's **Web Speech
API** — free, no server cost — relayed to listeners, who get a **CC** toggle.

Limitations: Chrome/Edge (and Safari) only, **English-oriented — no Dhivehi**, and
accuracy depends on the broadcaster's browser. Captions are live-only (not saved).

---

## Latency & reliability

Tuned for **~1.5s behind live** on a good network, **continuity-first**:

- Fast networks stay near the live edge.
- A network hiccup makes playback **fall behind rather than skip** (nothing is
  missed), then it **gently speeds up** to catch back toward the edge.
- The server keeps a ~60s backlog so brief outages are recoverable.
- A WebSocket **heartbeat** drops dead sockets, and a reconnecting broadcaster
  **reclaims a stale session** — a broadcaster-side blip never locks the room.

This is intentionally **not sub-second**: true sub-second live audio needs WebRTC,
which stops playing when a phone is locked/backgrounded — the whole reason AirWave
uses HLS.

---

## Configuration

All via environment variables (see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `BROADCAST_PASSWORD` | `change-me` | Password required to go live. |
| `LISTEN_KEY` | *(empty)* | Listener access key; empty = public. Change it and redeploy to rotate/revoke. |
| `TUNNEL_TOKEN` | *(empty)* | Cloudflare named-tunnel token. |
| `RECORD` | `1` | Master switch for the recording feature (`0` disables). |
| `PORT` | `8080` | App listen port. |

The `recordings/` MP3 archive is persisted to the host via a volume (see
[docker-compose.yml](docker-compose.yml)).

---

## Project structure

```
server.js              Node + ffmpeg server (ingest, HLS, recording, status)
Dockerfile             Node 20 + ffmpeg image
docker-compose.yml     app + Cloudflare tunnel services
public/
  index.html           landing page
  broadcast.html       broadcaster (mic/line, login, captions, recording)
  listen.html          listener (HLS playback, captions)
  recordings.html      recordings archive
  util.js              shared client helpers
  app.css              styles
  vendor/hls.min.js    hls.js (bundled locally)
```

Generated at runtime and git-ignored: `hls/`, `recordings/`, `node_modules/`, `.env`.

---

## Limitations

- One broadcaster at a time (a second login is rejected while someone is live).
- HLS latency (~1.5s+), not sub-second — the trade for background playback.
- Captions are English-only and browser-dependent.
- A network outage longer than the ~60s backlog will lose that gap for a listener.

---

## License

MIT — see [LICENSE](LICENSE).
