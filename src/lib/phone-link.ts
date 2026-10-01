/**
 * La PC del lado del iPhone: se conecta al servidor local (phone.rs), contesta
 * la oferta del teléfono y entrega su video como un MediaStream más, igual
 * que una webcam.
 */

import { invoke } from "@tauri-apps/api/core";
import { PHONE_PORT, parse, type Facing, type PhoneScript, type ToPc, type ToPhone } from "./phone-protocol";
import type { UploadResult } from "./phone-take";

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
  /** La toma que graba el teléfono: lo que ya llegó y los segundos que faltan. */
  upload: { sentBytes: number; pending: number } | null;
};

export const IDLE: LinkState = { server: false, phone: false, video: false, facing: null, size: null, error: null, upload: null };

/** Cuánto esperar a que el teléfono diga que arrancó a grabar. */
const START_TIMEOUT = 20_000;

type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

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
  private starting = new Map<string, Waiter<{ mime: string; warning: string | null }>>();
  private stopping = new Map<string, Waiter<UploadResult>>();
  /** Tomas que el teléfono terminó solo (se cortó), hasta que la PC las cierre. */
  private ended = new Map<string, UploadResult>();

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
      this.failTakes("Se cortó el servidor del iPhone");
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
        if (!msg.connected) {
          this.closePeer();
          this.failTakes("El iPhone se desconectó");
        }
        break;
      case "recording": {
        const w = this.starting.get(msg.take);
        this.starting.delete(msg.take);
        if (msg.mime) {
          this.set({ upload: { sentBytes: 0, pending: 0 } });
          w?.resolve({ mime: msg.mime, warning: msg.error });
        } else w?.reject(new Error(msg.error ?? "El iPhone no pudo grabar"));
        break;
      }
      case "upload":
        this.set({ upload: { sentBytes: msg.sentBytes, pending: msg.pending } });
        break;
      case "recorded": {
        const result = { chunks: msg.chunks, bytes: msg.bytes, error: msg.error };
        const w = this.stopping.get(msg.take);
        this.stopping.delete(msg.take);
        this.set({ upload: null });
        if (w) w.resolve(result);
        else this.ended.set(msg.take, result);
        break;
      }
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

  /** Que el teléfono grabe a calidad completa; resuelve con el formato. */
  startTake(take: string, bitrate: number): Promise<{ mime: string; warning: string | null }> {
    if (!this.state.phone) return Promise.reject(new Error("El iPhone no está conectado"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.starting.delete(take);
        reject(new Error("El iPhone no contestó"));
      }, START_TIMEOUT);
      this.starting.set(take, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ type: "record", take, bitrate });
    });
  }

  /** Termina la toma y espera a que el teléfono suba todo. */
  stopTake(take: string): Promise<UploadResult> {
    const done = this.ended.get(take);
    if (done) {
      this.ended.delete(take);
      return Promise.resolve(done);
    }
    if (!this.state.phone) return Promise.reject(new Error("El iPhone se desconectó"));
    return new Promise((resolve, reject) => {
      this.stopping.set(take, { resolve, reject });
      this.send({ type: "record-stop", take });
    });
  }

  private failTakes(message: string) {
    for (const w of [...this.starting.values(), ...this.stopping.values()]) w.reject(new Error(message));
    this.starting.clear();
    this.stopping.clear();
    if (this.state.upload) this.set({ upload: null });
  }

  /** La imagen se colgó: que el teléfono vuelva a ofrecer. */
  restart() {
    this.send({ type: "restart" });
  }

  stop() {
    this.stopped = true;
    this.failTakes("Se cerró la cámara del iPhone");
    clearTimeout(this.retry);
    this.closePeer();
    this.ws?.close();
    this.ws = null;
  }
}
