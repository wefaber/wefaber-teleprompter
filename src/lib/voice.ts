/**
 * La voz del coach: dice los consejos cortos ("Más lento", "Fuera de foco")
 * por los auriculares, en las pausas, para no tener que leerlos mientras
 * grabás. Con parlantes el micrófono la levantaría, por eso lo normal es que
 * hable solo con auriculares.
 *
 * Un proveedor es cualquier cosa que sepa decir un texto. Hoy: las voces
 * neurales de Edge (en Rust, `tts.rs`) y, sin internet, las de Windows.
 */

import { invoke } from "@tauri-apps/api/core";

export type VoiceMode = "apagada" | "auriculares" | "siempre";

/** Voz elegida: "edge:<nombre>" o "sistema". Un proveedor nuevo suma su prefijo. */
export type VoiceId = string;

export const SYSTEM_VOICE = "sistema";

export const VOICES: { id: VoiceId; label: string }[] = [
  { id: "edge:es-AR-TomasNeural", label: "Tomás · Argentina" },
  { id: "edge:es-AR-ElenaNeural", label: "Elena · Argentina" },
  { id: "edge:es-MX-JorgeNeural", label: "Jorge · México" },
  { id: "edge:es-MX-DaliaNeural", label: "Dalia · México" },
  { id: "edge:es-ES-AlvaroNeural", label: "Álvaro · España" },
  { id: "edge:es-ES-ElviraNeural", label: "Elvira · España" },
  { id: SYSTEM_VOICE, label: "La de Windows, sin internet" },
];

/** Un poco más rápido que lo normal: son dos o tres palabras. */
const RATE = 10;

const HEADPHONES = /auricular|headphone|headset|earbud|earphone|airpods|buds|manos libres|hands-free|quadcast/i;

/**
 * Por el nombre de la salida de Windows. El QuadCast cuenta: su "parlante" es
 * la salida de auriculares del micrófono.
 */
export function isHeadphones(output: string | null): boolean {
  return output !== null && HEADPHONES.test(output);
}

export function audioOutput(): Promise<string | null> {
  return invoke<string | null>("audio_output");
}

export interface Speaker {
  speak(text: string): Promise<void>;
  stop(): void;
}

/** Las voces de Edge. Cada frase se pide una vez y queda en memoria. */
export class EdgeSpeaker implements Speaker {
  private voice: string;
  private cache = new Map<string, Promise<string>>();
  private audio: HTMLAudioElement | null = null;

  constructor(voice: string) {
    this.voice = voice;
  }

  /** Para que el primer consejo no tarde lo que tarda el servicio. */
  prepare(text: string): Promise<string> {
    let url = this.cache.get(text);
    if (!url) {
      url = invoke<string>("tts_edge", { text, voice: this.voice, rate: RATE }).then((b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      });
      // Si falla, que se pueda volver a pedir.
      url.catch(() => this.cache.delete(text));
      this.cache.set(text, url);
    }
    return url;
  }

  async speak(text: string): Promise<void> {
    const url = await this.prepare(text);
    this.stop();
    const audio = new Audio(url);
    this.audio = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error("No se pudo reproducir la voz"));
      audio.play().catch(reject);
    });
  }

  stop(): void {
    this.audio?.pause();
    this.audio = null;
  }

  dispose(): void {
    this.stop();
    for (const url of this.cache.values()) void url.then(URL.revokeObjectURL, () => {});
    this.cache.clear();
  }
}

/** Las voces instaladas en Windows: andan sin internet, suenan más a robot. */
export class SystemSpeaker implements Speaker {
  speak(text: string): Promise<void> {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.reject(new Error("Este sistema no tiene voces"));
    const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
    const pick = ["es-ar", "es-us", "es-mx", "es-419", "es-es"]
      .map((lang) => voices.find((v) => v.lang.toLowerCase() === lang))
      .find(Boolean) ?? voices[0];
    const u = new SpeechSynthesisUtterance(text);
    if (pick) u.voice = pick;
    u.lang = pick?.lang ?? "es-AR";
    u.rate = 1 + RATE / 100;
    return new Promise((resolve) => {
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.cancel();
      synth.speak(u);
    });
  }

  stop(): void {
    window.speechSynthesis?.cancel();
  }
}

export type AnnouncerOptions = {
  /** Silencio tuyo antes de hablar, para no pisarte. */
  quietMs: number;
  /** Si no hacés una pausa en este tiempo, el consejo ya no sirve. */
  staleMs: number;
  /** Entre dos frases de la voz. */
  gapMs: number;
};

export const DEFAULT_ANNOUNCER: AnnouncerOptions = { quietMs: 450, staleMs: 7_000, gapMs: 2_500 };

/**
 * Cuándo hablar. Se queda con el último consejo (el anterior ya no importa) y
 * lo suelta en la primera pausa tuya.
 */
export class Announcer {
  private pending: { text: string; at: number } | null = null;
  private lastVoice = -Infinity;
  private lastSpeech = -Infinity;
  private busy = false;
  options: AnnouncerOptions;

  constructor(options: AnnouncerOptions = DEFAULT_ANNOUNCER) {
    this.options = options;
  }

  push(text: string, now: number): void {
    this.pending = { text, at: now };
  }

  /** Cada tanto, con si estás hablando. Devuelve qué decir ahora, si algo. */
  tick(now: number, speaking: boolean): string | null {
    if (speaking) this.lastSpeech = now;
    const p = this.pending;
    if (!p) return null;
    if (now - p.at > this.options.staleMs) {
      this.pending = null;
      return null;
    }
    if (this.busy || speaking) return null;
    if (now - this.lastSpeech < this.options.quietMs) return null;
    if (now - this.lastVoice < this.options.gapMs) return null;
    this.pending = null;
    this.busy = true;
    return p.text;
  }

  /** La voz terminó de hablar. */
  done(now: number): void {
    this.busy = false;
    this.lastVoice = now;
  }

  reset(): void {
    this.pending = null;
    this.busy = false;
  }
}
