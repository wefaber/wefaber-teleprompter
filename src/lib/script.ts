/**
 * Formato del guion, pensado para escribirlo a mano:
 *
 *   # Sección
 *   ## Punto
 *   claves: palabra, otra, frase de dos
 *   - viñeta
 *   nota: algo para no olvidarse (se ve, no se usa para seguir)
 *   diapo: media/portada.png         (imagen o .html: lo que ve el público)
 *   video: media/demo.mp4 0:12-0:40 auto
 *
 * Una línea suelta cuenta como viñeta. Una viñeta antes del primer `##` de la
 * sección arma un punto con el nombre de la sección.
 */

export type Point = {
  id: string;
  section: number;
  title: string;
  bullets: string[];
  notes: string[];
  keys: string[];
  /** Archivo de la diapositiva, relativo a la carpeta del mazo. */
  slide?: string;
  video?: VideoCue;
};

/** Un video dentro de la presentación; los tiempos en segundos. */
export type VideoCue = { file: string; start?: number; end?: number; auto: boolean };

export type Section = { title: string; first: number; last: number };

export type Doc = { sections: Section[]; points: Point[] };

const KEYS = /^(claves?|keys?)\s*:\s*/i;
const NOTE = /^(nota|note)\s*:\s*/i;
const SLIDE = /^(diapo|slide)\s*:\s*/i;
const VIDEO = /^video\s*:\s*/i;
const SLIDE_FILE = /\.(png|jpe?g|webp|gif|svg|avif|html?)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)$/i;

/** "1:05" son 65 s; "75", 75 s; "1:02:03", 3723 s. null si no es un tiempo. */
export function parseTime(s: string): number | null {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** `media/demo.mp4 0:12-0:40 auto`. null si no nombra un video: entonces la línea es una viñeta. */
export function parseVideo(spec: string): VideoCue | null {
  const tokens = spec.trim().split(/\s+/);
  let auto = false;
  let start: number | undefined;
  let end: number | undefined;
  // El nombre puede tener espacios: es lo que queda al sacar del final el rango y `auto`.
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (/^auto$/i.test(last)) {
      auto = true;
      tokens.pop();
      continue;
    }
    const m = /^([\d:]*)-([\d:]*)$/.exec(last);
    const from = m?.[1] ? parseTime(m[1]) : undefined;
    const to = m?.[2] ? parseTime(m[2]) : undefined;
    if (m && (m[1] || m[2]) && from !== null && to !== null) {
      start = from;
      end = to;
      tokens.pop();
      continue;
    }
    break;
  }
  const file = tokens.join(" ");
  if (!VIDEO_FILE.test(file)) return null;
  const cue: VideoCue = { file, auto };
  if (start !== undefined) cue.start = start;
  if (end !== undefined) cue.end = end;
  return cue;
}

/** `diapo:` o `video:` que nombran un archivo que se puede mostrar. Si no, la línea es una viñeta. */
function mediaOf(line: string): Pick<Point, "slide" | "video"> | null {
  if (SLIDE.test(line)) {
    const slide = line.replace(SLIDE, "").trim();
    return SLIDE_FILE.test(slide) ? { slide } : null;
  }
  if (VIDEO.test(line)) {
    const video = parseVideo(line.replace(VIDEO, ""));
    return video ? { video } : null;
  }
  return null;
}

export function parseScript(text: string): Doc {
  const sections: Section[] = [];
  const points: Point[] = [];
  let current: Point | null = null;

  const ensureSection = () => {
    if (sections.length === 0) sections.push({ title: "Guion", first: 0, last: -1 });
    return sections.length - 1;
  };
  const ensurePoint = (): Point => {
    if (current) return current;
    const section = ensureSection();
    current = {
      id: `p${points.length}`,
      section,
      title: sections[section]?.title ?? "Punto",
      bullets: [],
      notes: [],
      keys: [],
    };
    points.push(current);
    return current;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const media = mediaOf(line);

    if (line.startsWith("## ")) {
      const section = ensureSection();
      current = {
        id: `p${points.length}`,
        section,
        title: line.slice(3).trim(),
        bullets: [],
        notes: [],
        keys: [],
      };
      points.push(current);
    } else if (line.startsWith("# ")) {
      sections.push({ title: line.slice(2).trim(), first: points.length, last: -1 });
      current = null;
    } else if (KEYS.test(line)) {
      const point = ensurePoint();
      point.keys.push(
        ...line
          .replace(KEYS, "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      );
    } else if (NOTE.test(line)) {
      ensurePoint().notes.push(line.replace(NOTE, ""));
    } else if (media) {
      Object.assign(ensurePoint(), media);
    } else {
      ensurePoint().bullets.push(line.replace(/^[-*•]\s*/, ""));
    }
  }

  // Rango de puntos de cada sección; las vacías quedan con last < first.
  sections.forEach((s, i) => {
    s.first = points.findIndex((p) => p.section === i);
    s.last = s.first === -1 ? -1 : s.first + points.filter((p) => p.section === i).length - 1;
  });

  return { sections, points };
}
