/** Small shared helpers for the broadcaster/listener pages. */

/** Open the status WebSocket; `onMsg` receives parsed JSON. Auto-reconnects. */
export function openStatusSocket(role, onMsg) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null, closed = false, retry = 0;
  function connect() {
    ws = new WebSocket(`${proto}://${location.host}/ws/status?role=${role}`);
    ws.addEventListener("message", (e) => { try { onMsg(JSON.parse(e.data)); } catch {} });
    ws.addEventListener("open", () => { retry = 0; });
    ws.addEventListener("close", () => {
      if (closed) return;
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    });
  }
  connect();
  return { close() { closed = true; try { ws && ws.close(); } catch {} } };
}

/** List audio input/output devices. Labels appear only after a permission grant. */
export async function listDevices(kind) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === kind);
}

/** Fill a <select> with devices, preserving the current selection if possible. */
export function fillDeviceSelect(select, devices, fallbackLabel) {
  const prev = select.value;
  select.innerHTML = "";
  devices.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.appendChild(opt);
  });
  if (devices.some((d) => d.deviceId === prev)) select.value = prev;
  select.disabled = devices.length === 0;
}

/** Pick the first MediaRecorder mime type the browser supports. */
export function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}
