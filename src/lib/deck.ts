/**
 * El mazo: la carpeta de una presentación (`guion.md` + archivos) y lo que se
 * le manda a la ventana del público. Sin nada de Tauri: se prueba solo.
 */

import type { Point } from "./script";

export type MediaKind = "imagen" | "html" | "video";

/** Qué es un archivo por su extensión. null si no se puede mostrar. */
export function mediaKind(file: string): MediaKind | null {
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file)) return "imagen";
  if (/\.html?$/i.test(file)) return "html";
  if (/\.(mp4|webm|mov|m4v)$/i.test(file)) return "video";
  return null;
}

/**
 * La ruta completa de un archivo del mazo, con barras de Windows. Una ruta
 * absoluta queda como está. null sin carpeta o si sale de ella con `..`.
 */
export function resolveMedia(folder: string | undefined, file: string): string | null {
  const f = file.trim().replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(f) || f.startsWith("\\\\")) return f;
  if (!folder) return null;
  const rel = f.replace(/^\.\\/, "");
  if (rel.split("\\").includes("..")) return null;
  return `${folder.replace(/[\\/]+$/, "")}\\${rel}`;
}

/** Si el video llegó al final de su rango. */
export function pastEnd(currentTime: number, end: number | undefined): boolean {
  return end !== undefined && currentTime >= end;
}

/** Lo que ve el público, tal cual viaja en el evento `audiencia:estado`. */
export type AudienceState = {
  /** Id del punto: cambia la diapositiva y reinicia el video. */
  id: string;
  title: string;
  bullets: string[];
  slide: { path: string; kind: "imagen" | "html" } | null;
  video: { path: string; start?: number; end?: number } | null;
  /** El archivo que se pidió y no se puede mostrar (para avisar en la diapositiva simple). */
  missing: string | null;
  black: boolean;
  playing: boolean;
};

export const EMPTY_AUDIENCE: AudienceState = {
  id: "",
  title: "",
  bullets: [],
  slide: null,
  video: null,
  missing: null,
  black: true,
  playing: false,
};

export function audienceState(point: Point | undefined, folder: string | undefined, black: boolean, playing: boolean): AudienceState {
  if (!point) return { ...EMPTY_AUDIENCE, black };
  const state: AudienceState = { ...EMPTY_AUDIENCE, id: point.id, title: point.title, bullets: point.bullets, black, playing };
  if (point.video) {
    const path = resolveMedia(folder, point.video.file);
    if (!path) return { ...state, missing: point.video.file };
    const video: AudienceState["video"] = { path };
    if (point.video.start !== undefined) video.start = point.video.start;
    if (point.video.end !== undefined) video.end = point.video.end;
    return { ...state, video };
  }
  if (point.slide) {
    const path = resolveMedia(folder, point.slide);
    const kind = mediaKind(point.slide);
    if (!path || (kind !== "imagen" && kind !== "html")) return { ...state, missing: point.slide };
    return { ...state, slide: { path, kind } };
  }
  return state;
}
