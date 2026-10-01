/**
 * De dónde sale el texto: Parakeet dentro de la app de escritorio, o el
 * reconocimiento del navegador cuando se abre la interfaz suelta en Chrome
 * (sirve para probar la interfaz sin compilar Rust).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Prosody } from "./coach";
import type { Transport } from "./llm";

export type SpeechState = "idle" | "loading" | "listening" | "error" | "unavailable";

export type SpeechHandlers = {
  onPartial: (text: string) => void;
  /** Con Parakeet llega también cómo se dijo la frase; el navegador no lo sabe. */
  onFinal: (text: string, prosody: Prosody | null) => void;
  onState: (state: SpeechState, message?: string) => void;
  /** silent: el micrófono manda silencio absoluto (muteado o sin ganancia). */
  onLevel: (level: number, speaking: boolean, silent: boolean) => void;
};

export type ModelInfo = { present: boolean; path: string; name: string };
export type ModelProgress = { downloaded: number; total: number | null; stage: "download" | "extract" };

export interface Recognizer {
  readonly engine: "parakeet" | "navegador" | "ninguno";
  start(device?: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export async function modelInfo(): Promise<ModelInfo | null> {
  if (!inTauri()) return null;
  return invoke<ModelInfo>("model_info");
}

export async function downloadModel(onProgress: (p: ModelProgress) => void): Promise<ModelInfo> {
  const unlisten: UnlistenFn[] = [];
  try {
    return await new Promise<ModelInfo>((resolve, reject) => {
      Promise.all([
        listen<ModelProgress>("model://progress", (e) => onProgress(e.payload)),
        listen<ModelInfo>("model://done", (e) => resolve(e.payload)),
        listen<string>("model://error", (e) => reject(new Error(e.payload))),
      ])
        .then((fns) => {
          unlisten.push(...fns);
          return invoke("model_download");
        })
        .catch(reject);
    });
  } finally {
    for (const fn of unlisten) fn();
  }
}

export async function llmAvailable(): Promise<boolean> {
  if (!inTauri()) return false;
  return (await invoke<{ available: boolean }>("llm_status")).available;
}

export const tauriTransport: Transport = (system, user, maxTokens) =>
  invoke<string>("llm_json", { system, user, maxTokens });

export async function listInputs(): Promise<string[]> {
  if (!inTauri()) return [];
  return invoke<string[]>("list_inputs");
}

class ParakeetRecognizer implements Recognizer {
  readonly engine = "parakeet" as const;
  private unlisten: Promise<UnlistenFn[]>;
  private h: SpeechHandlers;

  constructor(h: SpeechHandlers) {
    this.h = h;
    this.unlisten = Promise.all([
      listen<{ text: string }>("stt://partial", (e) => h.onPartial(e.payload.text)),
      listen<{ text: string; prosody: Prosody | null }>("stt://final", (e) =>
        h.onFinal(e.payload.text, e.payload.prosody),
      ),
      listen<{ level: number; speaking: boolean; silent?: boolean }>("stt://level", (e) =>
        h.onLevel(e.payload.level, e.payload.speaking, e.payload.silent ?? false),
      ),
      listen<{ state: string; message: string | null }>("stt://status", (e) => {
        const map: Record<string, SpeechState> = {
          loading: "loading",
          listening: "listening",
          stopped: "idle",
          error: "error",
        };
        h.onState(map[e.payload.state] ?? "idle", e.payload.message ?? undefined);
      }),
    ]);
  }

  async start(device?: string) {
    await this.unlisten;
    this.h.onState("loading");
    try {
      await invoke("stt_start", { device: device || null });
    } catch (e) {
      this.h.onState("error", String(e));
    }
  }

  async stop() {
    await invoke("stt_stop");
    this.h.onState("idle");
  }

  dispose() {
    void this.unlisten.then((fns) => fns.forEach((fn) => fn()));
    void invoke("stt_stop").catch(() => {});
  }
}

/** Lo mínimo de la Web Speech API que se usa, sin depender de lib.dom. */
type WebRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

class BrowserRecognizer implements Recognizer {
  readonly engine = "navegador" as const;
  private rec: WebRecognition | null = null;
  private wanted = false;
  private h: SpeechHandlers;
  private Ctor: new () => WebRecognition;

  constructor(h: SpeechHandlers, Ctor: new () => WebRecognition) {
    this.h = h;
    this.Ctor = Ctor;
  }

  async start() {
    this.wanted = true;
    const rec = new this.Ctor();
    rec.lang = "es-UY";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) this.h.onFinal(r[0].transcript, null);
        else interim += r[0].transcript;
      }
      if (interim) this.h.onPartial(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.wanted = false;
      this.h.onState("error", e.error === "not-allowed" ? "Sin permiso para el micrófono" : e.error);
    };
    // Chrome corta solo cada tanto; si se sigue queriendo, se retoma.
    rec.onend = () => {
      if (this.wanted) setTimeout(() => this.wanted && rec.start(), 200);
      else this.h.onState("idle");
    };
    this.rec = rec;
    rec.start();
    this.h.onState("listening");
  }

  async stop() {
    this.wanted = false;
    this.rec?.stop();
  }

  dispose() {
    this.wanted = false;
    this.rec?.stop();
  }
}

class NoRecognizer implements Recognizer {
  readonly engine = "ninguno" as const;
  private h: SpeechHandlers;
  constructor(h: SpeechHandlers) {
    this.h = h;
  }
  async start() {
    this.h.onState("unavailable", "Este navegador no reconoce voz. Abrí la app de escritorio o Chrome.");
  }
  async stop() {}
  dispose() {}
}

export function createRecognizer(h: SpeechHandlers): Recognizer {
  if (inTauri()) return new ParakeetRecognizer(h);
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => WebRecognition) | undefined;
  return Ctor ? new BrowserRecognizer(h, Ctor) : new NoRecognizer(h);
}
