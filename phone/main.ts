/**
 * La página del iPhone: abre la cámara, se la manda a la PC por WebRTC y,
 * con la frontal, muestra el guion pegado al lente. Habla el protocolo de
 * src/lib/phone-protocol.ts; una app nativa podría reemplazarla.
 */

import { parse, type Facing, type PhoneScript, type ToPc, type ToPhone } from "../src/lib/phone-protocol";

const FACING_KEY = "apuntador:camara";
/** Tope de la vista previa: se ve bien y no ahoga el WiFi. */
const PREVIEW_BITRATE = 6_000_000;
const PREVIEW_LONG_SIDE = 1280;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const statusText = $("status");
const dot = $("dot");

const token = new URLSearchParams(location.search).get("t") ?? "";
let facing: Facing = readFacing();
let stream: MediaStream | null = null;
let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let pcHere = false;
let cameraError: string | null = null;
let script: PhoneScript | null = null;
/** El último reloj de la PC y cuándo llegó; entre mensajes cuenta el teléfono. */
let clock = { elapsedMs: 0, running: false, recMs: null as number | null, at: 0 };

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function renderClock() {
  const since = performance.now() - clock.at;
  $("clock").textContent = mmss(clock.elapsedMs + (clock.running ? since : 0));
  $("clock").classList.toggle("paused", !clock.running);
  const rec = $("rec");
  rec.hidden = clock.recMs === null;
  if (clock.recMs !== null) rec.textContent = `● REC ${mmss(clock.recMs + since)}`;
}
setInterval(renderClock, 250);

function setLight(color: string) {
  // Solo colores de verdad: el valor va a una variable de CSS.
  if (!/^#[0-9a-f]{3,8}$/i.test(color)) return;
  document.documentElement.style.setProperty("--light", color);
  document.body.style.setProperty("--light", color);
  syncThemeColor();
}

/** La barra de Safari del mismo color que el fondo. */
function syncThemeColor() {
  const light = getComputedStyle(document.body).getPropertyValue("--light").trim() || "#ffffff";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", facing === "user" ? light : "#000000");
}

function readFacing(): Facing {
  try {
    return localStorage.getItem(FACING_KEY) === "user" ? "user" : "environment";
  } catch {
    return "environment";
  }
}

function saveFacing(f: Facing) {
  try {
    localStorage.setItem(FACING_KEY, f);
  } catch {
    // Vuelve a la trasera la próxima vez.
  }
}

function setStatus(text: string, on = false) {
  statusText.textContent = text;
  dot.classList.toggle("on", on);
}

function showLive() {
  setStatus(facing === "user" ? "En vivo · frontal" : "En vivo · trasera", true);
}

function send(msg: ToPc) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendStatus() {
  const s = stream?.getVideoTracks()[0]?.getSettings();
  send({ type: "status", facing, width: s?.width ?? 0, height: s?.height ?? 0, error: cameraError });
}

async function openCamera(f: Facing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: f },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    },
  });
}

async function useFacing(f: Facing) {
  try {
    const next = await openCamera(f);
    const track = next.getVideoTracks()[0];
    const sender = pc?.getSenders().find((s) => s.track?.kind === "video");
    if (sender && track) {
      await sender.replaceTrack(track);
      await tunePreview(sender, track);
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = next;
    facing = f;
    cameraError = null;
    saveFacing(f);
    video.srcObject = next;
    document.body.classList.toggle("user", f === "user");
    syncThemeColor();
    renderScript();
    if (pc?.connectionState === "connected") showLive();
  } catch (e) {
    cameraError = e instanceof Error ? e.message : String(e);
    setStatus(`Sin cámara: ${cameraError}`);
  }
  sendStatus();
}

/** La vista previa va achicada; la cámara sigue a resolución completa. */
async function tunePreview(sender: RTCRtpSender, track: MediaStreamTrack) {
  const { width = 0, height = 0 } = track.getSettings();
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0]!.maxBitrate = PREVIEW_BITRATE;
  params.encodings[0]!.scaleResolutionDownBy = Math.max(1, Math.max(width, height) / PREVIEW_LONG_SIDE);
  try {
    await sender.setParameters(params);
  } catch {
    // Sin ajuste, va como el navegador decida.
  }
}

function closePeer() {
  pc?.close();
  pc = null;
}

async function offer() {
  closePeer();
  if (!stream) return;
  const peer = new RTCPeerConnection({ iceServers: [] });
  pc = peer;
  peer.onicecandidate = (e) => send({ type: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    const s = peer.connectionState;
    if (s === "connected") showLive();
    else if (s === "connecting") setStatus("Conectando la imagen…");
    else if (s === "failed") setStatus("No se pudo pasar la imagen. Probá con los dos en el mismo WiFi.");
  };
  for (const track of stream.getVideoTracks()) {
    const sender = peer.addTrack(track, stream);
    await tunePreview(sender, track);
  }
  const desc = await peer.createOffer();
  await peer.setLocalDescription(desc);
  send({ type: "offer", sdp: desc.sdp ?? "" });
}

async function onMessage(msg: ToPhone) {
  switch (msg.type) {
    case "peer":
      pcHere = msg.connected;
      if (msg.connected) {
        setStatus("PC encontrada, conectando…");
        sendStatus();
        await offer();
      } else {
        closePeer();
        setStatus("Esperando la PC… (abrí la vista previa del iPhone)");
      }
      break;
    case "answer":
      await pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      break;
    case "ice":
      if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
      break;
    case "facing":
      if (msg.facing !== facing) await useFacing(msg.facing);
      break;
    case "script":
      script = msg.script;
      renderScript();
      break;
    case "restart":
      await offer();
      break;
    case "clock":
      clock = { elapsedMs: msg.elapsedMs, running: msg.running, recMs: msg.recMs, at: performance.now() };
      renderClock();
      break;
    case "light":
      setLight(msg.color);
      break;
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws?role=phone&t=${encodeURIComponent(token)}`);
  ws = socket;
  setStatus("Buscando la PC…");
  socket.onopen = () => send({ type: "hello", device: navigator.userAgent });
  socket.onmessage = (e) => {
    const msg = parse<ToPhone>(e.data);
    if (msg) void onMessage(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    closePeer();
    pcHere = false;
    setStatus("Se cortó la conexión. Reintentando…");
    setTimeout(connect, 2_000);
  };
}

function renderScript() {
  $("section").textContent = script ? `${script.section} · ${script.index + 1}/${script.total}` : "";
  $("title").textContent = script?.title ?? (pcHere ? "" : "Esperando el guion de la PC");
  const list = $("bullets");
  list.replaceChildren(
    ...(script?.bullets ?? []).map((b, i) => {
      const li = document.createElement("li");
      li.textContent = b;
      if (script?.covered.includes(i)) li.className = "done";
      return li;
    }),
  );
  $("next-label").textContent = script?.next ? (script.nextSection ? `Después · ${script.nextSection}` : "Después") : "";
  $("next-title").textContent = script?.next ?? "";
  $("next-bullets").replaceChildren(
    ...(script?.nextBullets ?? []).map((b) => {
      const li = document.createElement("li");
      li.textContent = b;
      return li;
    }),
  );
  $("next").hidden = !script?.next;
}

// Que la pantalla no se apague: si se bloquea, Safari corta la cámara.
let lock: { release: () => Promise<void> } | null = null;
async function keepAwake() {
  const nav = navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
  try {
    lock = (await nav.wakeLock?.request("screen")) ?? null;
  } catch {
    lock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !lock) void keepAwake();
});

$("go").addEventListener("click", async () => {
  if (!token) {
    setStatus("Falta el token: escaneá el QR de la PC otra vez.");
    return;
  }
  $("start").remove();
  void keepAwake();
  await useFacing(facing);
  connect();
});

$("flip").addEventListener("click", () => void useFacing(facing === "user" ? "environment" : "user"));
