/**
 * Dónde corre el reconocimiento (ver src-tauri/src/engine.rs): esta PC con su
 * mejor acelerador, otra PC de la tailnet, o xAI por internet.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Doc } from "./script";

export type EngineMode = "auto" | "local" | "remota" | "xai";
export type Accel = "cpu" | "directml";

export type EngineConfig = {
  mode: EngineMode;
  accel: Accel | null;
  remoteUrl: string | null;
  remoteKey: string | null;
  keyterms: string[];
};

export type Hardware = { cpu: string; threads: number; ramGb: number; gpus: string[]; npus: string[] };
export type Trial = { accel: Accel; rtf: number | null; loadMs: number; error: string | null };
export type Report = { hardware: Hardware; trials: Trial[]; best: Accel | null; at: number };
export type EngineInfo = { hardware: Hardware; report: Report | null; xai: boolean; slowRtf: number };
export type ShareInfo = { on: boolean; url: string | null; key: string };
export type RemoteHealth = { name: string; accel: Accel | null };

export const ACCEL_LABEL: Record<Accel, string> = { cpu: "CPU", directml: "DirectML" };

/** Lo que xAI acepta: hasta 100 términos de hasta 50 caracteres. */
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;

/**
 * Los términos para xAI: primero las claves de cada punto (lo que de verdad
 * vas a decir), después los títulos. Sin repetir.
 */
export function keytermsOf(doc: Doc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const term = t.trim().slice(0, MAX_KEYTERM_CHARS);
    const k = term.toLowerCase();
    if (!term || seen.has(k) || out.length >= MAX_KEYTERMS) return;
    seen.add(k);
    out.push(term);
  };
  for (const p of doc.points) p.keys.forEach(add);
  for (const p of doc.points) add(p.title);
  return out;
}

/** "0,03×" → cuánto tarda por segundo de audio, y si alcanza para ir en vivo. */
/** Lo que da "Copiar" en Compartir esta PC: la dirección y la clave, una por línea. */
export function splitShare(text: string): { url: string; key: string } | null {
  const [url, key, ...rest] = text.split(/\s+/).filter(Boolean);
  return url && key && rest.length === 0 ? { url, key } : null;
}

export function speed(rtf: number | null, slow: number): string {
  if (rtf === null) return "no anduvo";
  const times = Math.max(1, Math.round(1 / rtf));
  return rtf <= slow ? `${times} veces más rápido que en vivo` : "demasiado lento para ir en vivo";
}

export const engineInfo = () => invoke<EngineInfo>("engine_info");
export const engineBench = () => invoke<Report | null>("engine_bench");
export const remoteCheck = (url: string, key: string) => invoke<RemoteHealth>("engine_remote_check", { url, key });
export const shareInfo = () => invoke<ShareInfo>("share_info");
export const shareStart = () => invoke<ShareInfo>("share_start");
export const shareStop = () => invoke<ShareInfo>("share_stop");
