/**
 * Formato del guion, pensado para escribirlo a mano:
 *
 *   # Sección
 *   ## Punto
 *   claves: palabra, otra, frase de dos
 *   - viñeta
 *   nota: algo para no olvidarse (se ve, no se usa para seguir)
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
};

export type Section = { title: string; first: number; last: number };

export type Doc = { sections: Section[]; points: Point[] };

const KEYS = /^(claves?|keys?)\s*:\s*/i;
const NOTE = /^(nota|note)\s*:\s*/i;

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
