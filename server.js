/**
 * Live one-way audio broadcast — HLS edition.
 *
 *   Broadcaster browser --(Opus/WebM over WebSocket)--> this server --ffmpeg--> HLS
 *   Listeners <--------------------- HLS over HTTP -----------------------------┘
 *
 * All traffic is HTTP/WebSocket, so it works behind a Cloudflare quick tunnel
 * with no public IP. Trade-off vs. WebRTC: ~4–8s latency, but audio keeps
 * playing when a phone is locked or the app is backgrounded (it's plain media).
 */
const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const PASSWORD = process.env.BROADCAST_PASSWORD || "change-me";
const RECORD = process.env.RECORD !== "0"; // set RECORD=0 to disable session recordings
const HLS_DIR = path.join(__dirname, "hls");
const REC_DIR = path.join(__dirname, "recordings");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(HLS_DIR, { recursive: true });
fs.mkdirSync(REC_DIR, { recursive: true });
cleanHls();

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// --- HTTP: static pages + HLS output -----------------------------------
const app = express();
app.use("/hls", express.static(HLS_DIR, {
  setHeaders(res, p) {
    if (p.endsWith(".m3u8")) res.setHeader("Cache-Control", "no-cache, no-store");
    else res.setHeader("Cache-Control", "public, max-age=60");
  },
}));
app.use("/rec", express.static(REC_DIR, {
  setHeaders(res) { res.setHeader("Cache-Control", "no-store"); },
}));
app.get("/api/recordings", (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(REC_DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const st = fs.statSync(path.join(REC_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  res.json({ recording: !!ffmpeg, files });
});
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

const server = http.createServer(app);

// --- Broadcast state ----------------------------------------------------
let ffmpeg = null;                 // running ffmpeg process, or null
let broadcaster = null;            // the one authenticated broadcaster socket
let epoch = 0;                     // increments each go-live
const statusSockets = new Map();   // ws -> role ("listener" | "broadcaster")

function live() { return !!ffmpeg; }
function listenerCount() {
  let n = 0;
  for (const role of statusSockets.values()) if (role === "listener") n++;
  return n;
}
function statusMsg() {
  return { type: "status", live: live(), epoch, listeners: listenerCount() };
}
function pushStatus() {
  const msg = JSON.stringify(statusMsg());
  for (const ws of statusSockets.keys()) { try { ws.send(msg); } catch {} }
}

function cleanHls() {
  try {
    for (const f of fs.readdirSync(HLS_DIR)) {
      if (/\.(ts|m3u8|m4s)$/.test(f)) fs.unlinkSync(path.join(HLS_DIR, f));
    }
  } catch {}
}

function startFfmpeg(record) {
  if (ffmpeg) return;
  cleanHls();
  epoch++;

  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+nobuffer+genpts",
    "-i", "pipe:0",                 // WebM/Opus (or MP4/AAC) from MediaRecorder
    // --- HLS output (live) ---
    "-map", "0:a", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-flush_packets", "1",
    "-f", "hls",
    "-hls_time", "0.5",             // 0.5s segments → low latency on good networks
    "-hls_list_size", "120",        // ~60s backlog so slow listeners can catch up (never miss)
    "-hls_flags", "delete_segments+append_list+independent_segments+program_date_time+omit_endlist",
    "-hls_segment_type", "mpegts",
    // Epoch in the name → each session has unique segment URLs, so a cached
    // segment from a previous session can never be replayed after a restart.
    "-hls_segment_filename", path.join(HLS_DIR, `seg_${epoch}_%05d.ts`),
    path.join(HLS_DIR, "index.m3u8"),
  ];

  if (record) {
    // --- Full-session recording (MP3, valid even if the process is killed) ---
    const recPath = path.join(REC_DIR, `broadcast_${stamp()}.mp3`);
    args.push(
      "-map", "0:a", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-f", "mp3", recPath
    );
    console.log("recording to", path.basename(recPath));
  }

  ffmpeg = spawn("ffmpeg", args);
  ffmpeg.stderr.on("data", (d) => process.stderr.write(`[ffmpeg] ${d}`));
  ffmpeg.stdin.on("error", () => {});
  ffmpeg.on("close", (code) => {
    console.log(`ffmpeg exited (${code})`);
    ffmpeg = null;
    pushStatus();
    cleanHls();
  });
  console.log("ffmpeg started, epoch", epoch);
  pushStatus();
}

function stopFfmpeg() {
  if (!ffmpeg) return;
  const p = ffmpeg;
  ffmpeg = null;
  // EOF on stdin lets ffmpeg finalize the recording; SIGKILL only as a fallback.
  try { p.stdin.end(); } catch {}
  const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000);
  p.once("close", () => clearTimeout(killer));
  pushStatus();
  cleanHls();
}

// --- WebSocket: /ws/broadcast (ingest) + /ws/status --------------------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  if (pathname === "/ws/broadcast" || pathname === "/ws/status") {
    const role = url.searchParams.get("role") === "broadcaster" ? "broadcaster" : "listener";
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, pathname, role));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, pathname, role) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  if (pathname === "/ws/status") {
    statusSockets.set(ws, role);
    try { ws.send(JSON.stringify(statusMsg())); } catch {}
    pushStatus();
    ws.on("close", () => { statusSockets.delete(ws); pushStatus(); });
    return;
  }

  // Broadcaster ingest socket.
  let authed = false;
  ws.on("message", (data, isBinary) => {
    if (!authed) {
      if (isBinary) return; // must authenticate first (text JSON)
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "auth") return;
      if (msg.password !== PASSWORD) {
        try { ws.send(JSON.stringify({ type: "auth", ok: false })); } catch {}
        try { ws.close(4001, "bad password"); } catch {}
        return;
      }
      if (broadcaster && broadcaster !== ws) {
        if (broadcaster.readyState === broadcaster.OPEN) {
          // A live broadcaster is genuinely connected.
          try { ws.send(JSON.stringify({ type: "auth", ok: false, reason: "busy" })); } catch {}
          try { ws.close(4002, "already broadcasting"); } catch {}
          return;
        }
        // Stale/dead broadcaster socket — reclaim it.
        try { broadcaster.terminate(); } catch {}
        broadcaster = null;
        stopFfmpeg();
      }
      authed = true;
      broadcaster = ws;
      try { ws.send(JSON.stringify({ type: "auth", ok: true })); } catch {}
      return;
    }

    if (isBinary) {
      if (ffmpeg && ffmpeg.stdin.writable) { try { ffmpeg.stdin.write(data); } catch {} }
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "start") {
      startFfmpeg(RECORD && !!msg.record);   // record only if the feature is enabled AND requested
      try { ws.send(JSON.stringify({ type: "ready" })); } catch {}
    } else if (msg.type === "stop") {
      stopFfmpeg();
    } else if (msg.type === "caption") {
      // Relay live captions from the broadcaster to all listeners.
      const c = JSON.stringify({ type: "caption", text: String(msg.text || "").slice(0, 500), final: !!msg.final });
      for (const s of statusSockets.keys()) { try { s.send(c); } catch {} }
    }
  });

  ws.on("close", () => {
    if (ws === broadcaster) { broadcaster = null; stopFfmpeg(); }
  });
});

// Heartbeat: terminate sockets that stop responding (detects dead broadcaster/
// listener connections that never fired a clean 'close' — e.g. mobile drops).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`listening on :${PORT}`));
