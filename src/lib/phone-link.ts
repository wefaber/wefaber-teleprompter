/**
 * La PC del lado del iPhone: se conecta al servidor local (phone.rs), contesta
 * la oferta del teléfono y entrega su video como un MediaStream más, igual
 * que una webcam.
 */

import { invoke } from "@tauri-apps/api/core";
import { PHONE_PORT, parse, type Facing, type PhoneScript, type ToPc, type ToPhone } from "./phone-protocol";

export type PhoneInfo = {
  token: string;
  port: number;
  url: string | null;
  /** La dirección es el link temporal por internet (Funnel), no la tailnet. */
  public: boolean;
  error: string | null;
};

/** Cómo llega el teléfono: por la tailnet o por un link temporal por internet. */
export type PhoneRoute = "tailnet" | "temporal";

export type LinkState = {
  /** El servidor local responde. */
  server: boolean;
  /** Hay un teléfono conectado. */
  phone: boolean;
  /** La imagen llega. */
  video: boolean;
  facing: Facing | null;
  /** Lo que da la cámara del teléfono, no la vista previa: "3840x2160". */
  size: string | null;
  error: string | null;
};

export const IDLE: LinkState = { server: false, phone: false, video: false, facing: null, size: null, error: null };

export function phoneInfo(): Promise<PhoneInfo> {
  return invoke<PhoneInfo>("phone_info");
}

let publicQueue: Promise<unknown> = Promise.resolve();

/**
 * Abre o cierra el link temporal y devuelve la dirección que corresponde. En
 * fila: si se prende y apaga rápido, Tailscale los recibe en ese orden.
 */
export function phonePublic(on: boolean): Promise<PhoneInfo> {
  const next = publicQueue.catch(() => {}).then(() => invoke<PhoneInfo>("phone_public", { on }));
  publicQueue = next;
  return next;
}

type Handlers = {
  onStream: (stream: MediaStream | null) => void;
  onState: (state: LinkState) => void;
};

export class PhoneLink {
  private token: string;
  private h: Handlers;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  /** Candidatos que llegan antes de que la oferta esté puesta. */
  private early: RTCIceCandidateInit[] = [];
  private state: LinkState = { ...IDLE };
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(token: string, h: Handlers) {
    this.token = token;
    this.h = h;
    this.connect();
  }

  private set(patch: Partial<LinkState>) {
    this.state = { ...this.state, ...patch };
    this.h.onState(this.state);
  }

  private send(msg: ToPhone) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PHONE_PORT}/ws?role=pc&t=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => this.set({ server: true, error: null });
    ws.onmessage = (e) => {
      const msg = parse<ToPc>(e.data);
      if (msg) void this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.closePeer();
      this.set({ server: false, phone: false, video: false });
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 1_500);
    };
  }

  private closePeer() {
    this.pc?.close();
    this.pc = null;
    this.early = [];
    this.h.onStream(null);
  }

  private async onMessage(msg: ToPc) {
    switch (msg.type) {
      case "peer":
        this.set({ phone: msg.connected, ...(msg.connected ? {} : { video: false }) });
        if (!msg.connected) this.closePeer();
        break;
      case "hello":
        break;
      case "status":
        this.set({
          facing: msg.facing,
          size: msg.width && msg.height ? `${msg.width}x${msg.height}` : null,
          error: msg.error,
        });
        break;
      case "offer":
        await this.answer(msg.sdp);
        break;
      case "ice":
        if (!msg.candidate) break;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(msg.candidate).catch(() => {});
        else this.early.push(msg.candidate);
        break;
    }
  }

  private async answer(sdp: string) {
    this.closePeer();
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.onicecandidate = (e) => this.send({ type: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
    // El track aparece con la oferta, antes de que pase un solo cuadro: la
    // imagen cuenta como llegada recién con la conexión hecha.
    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      this.h.onStream(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") this.set({ video: true });
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.set({ video: false });
        this.h.onStream(null);
        // Que el teléfono vuelva a ofrecer (la red pudo cambiar); si mientras
        // tanto llegó otra oferta, esta ya no es la conexión actual.
        if (pc.connectionState === "failed") setTimeout(() => this.pc === pc && this.restart(), 3_000);
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    for (const c of this.early.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    const desc = await pc.createAnswer();
    await pc.setLocalDescription(desc);
    this.send({ type: "answer", sdp: desc.sdp ?? "" });
  }

  setFacing(facing: Facing) {
    this.send({ type: "facing", facing });
  }

  sendScript(script: PhoneScript | null) {
    this.send({ type: "script", script });
  }

  sendClock(elapsedMs: number, running: boolean, recMs: number | null) {
    this.send({ type: "clock", elapsedMs, running, recMs });
  }

  sendLight(color: string) {
    this.send({ type: "light", color });
  }

  /** La imagen se colgó: que el teléfono vuelva a ofrecer. */
  restart() {
    this.send({ type: "restart" });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.closePeer();
    this.ws?.close();
    this.ws = null;
  }
}
