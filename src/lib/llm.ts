/**
 * Lo que se le pide a DeepSeek. Se manda el guion y el texto transcripto,
 * nunca el audio.
 */

import type { Doc } from "./script";

/** Manda un pedido y devuelve el JSON en texto. En la app lo hace Rust. */
export type Transport = (system: string, user: string, maxTokens: number) => Promise<string>;

export const TONES = ["energía", "emoción", "calma", "cercanía", "claridad", "firmeza"] as const;
export type Tone = (typeof TONES)[number];

export type SectionTone = { tone: Tone; tip: string };

export type Located = {
  point: number | null;
  confidence: number;
  bullets: number[];
  offTopic: boolean;
};

export type Review = { note: string; tip: string };

function parse<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  return JSON.parse(cleaned) as T;
}

const VOICE =
  "Escribís en español rioplatense, voseo, frases cortas y concretas. Sin emojis, sin signos de exclamación, sin elogios.";

/** Una vez por guion: con qué tono conviene decir cada sección. */
export async function sectionTones(send: Transport, doc: Doc): Promise<SectionTone[]> {
  const system = `Sos director de cámara de videos explicativos para redes. ${VOICE}
Para cada sección del guion elegí el tono con que conviene decirla, de esta lista: ${TONES.join(", ")}.
Sumá un consejo de actuación de hasta 70 caracteres, pensado para esa sección y no genérico.
Respondé solo JSON: {"secciones":[{"i":0,"tono":"...","consejo":"..."}]}, una entrada por sección, en orden.`;
  const user = JSON.stringify({
    secciones: doc.sections.map((s, i) => ({
      i,
      titulo: s.title,
      puntos: doc.points.filter((p) => p.section === i).map((p) => [p.title, ...p.bullets].join(" / ")),
    })),
  });
  const out = parse<{ secciones?: { i: number; tono: string; consejo: string }[] }>(await send(system, user, 1_500));
  return doc.sections.map((_, i) => {
    const hit = out.secciones?.find((s) => s.i === i);
    const tone = (TONES as readonly string[]).includes(hit?.tono ?? "") ? (hit!.tono as Tone) : "claridad";
    return { tone, tip: (hit?.consejo ?? "").slice(0, 90) };
  });
}

/** Qué punto se está tocando por el sentido, no por las palabras. */
export async function locate(send: Transport, doc: Doc, current: number, before: string, now: string): Promise<Located> {
  const from = Math.max(0, current - 2);
  const to = Math.min(doc.points.length - 1, current + 6);
  const system = `Seguís una charla grabada contra los puntos de un guion. ${VOICE}
La persona no lee: explica con sus palabras, da ejemplos y a veces se va de tema.
Decidí de qué punto habla en "ahora", por el sentido y no por palabras sueltas. "antes" es solo contexto: si "ahora" cambió de tema, manda "ahora".
Si habla de algo que no es ningún punto, "punto" es null y "fuera_de_tema" es true.
"vinetas" son los índices (desde 0) de las viñetas de ESE punto que ya dijo con otras palabras.
Respondé solo JSON: {"punto":<número o null>,"confianza":<0 a 1>,"vinetas":[...],"fuera_de_tema":<bool>}.`;
  const user = JSON.stringify({
    punto_actual: current,
    puntos: doc.points.slice(from, to + 1).map((p, k) => ({ i: from + k, titulo: p.title, vinetas: p.bullets })),
    antes: before,
    ahora: now,
  });
  const out = parse<{ punto?: number | null; confianza?: number; vinetas?: number[]; fuera_de_tema?: boolean }>(
    await send(system, user, 300),
  );
  const point = typeof out.punto === "number" && out.punto >= from && out.punto <= to ? out.punto : null;
  const bullets = point === null ? [] : (out.vinetas ?? []).filter((b) => Number.isInteger(b) && b >= 0 && b < doc.points[point]!.bullets.length);
  return {
    point,
    confidence: Math.max(0, Math.min(1, Number(out.confianza) || 0)),
    bullets,
    offTopic: Boolean(out.fuera_de_tema),
  };
}

export type SectionStats = { wpm: number | null; toneSt: number | null; spreadSt: number | null; seconds: number };

/** Devolución al cerrar una sección: una observación y un consejo. */
export async function reviewSection(
  send: Transport,
  doc: Doc,
  section: number,
  said: string,
  stats: SectionStats,
  tone: SectionTone | undefined,
): Promise<Review> {
  const s = doc.sections[section];
  const system = `Sos coach de oratoria para videos. ${VOICE}
Te paso una sección del guion, lo que la persona dijo de verdad y cómo lo dijo.
Referencias: 140 a 170 palabras por minuto es cómodo para explicar; variación de tono (desvío) menor a 1.5 semitonos suena plano; el tono se mide contra la base de la persona (0 es su normal).
Devolvé una observación concreta sobre lo que pasó (qué quedó claro, qué punto faltó o se fue de largo) y un consejo accionable para la próxima toma. Cada uno de hasta 110 caracteres.
Respondé solo JSON: {"nota":"...","consejo":"..."}.`;
  const user = JSON.stringify({
    seccion: s?.title,
    tono_buscado: tone?.tone,
    puntos: doc.points.filter((p) => p.section === section).map((p) => ({ titulo: p.title, vinetas: p.bullets })),
    lo_que_dijo: said.slice(-4_000),
    como_lo_dijo: {
      palabras_por_minuto: stats.wpm,
      tono_vs_base_semitonos: stats.toneSt === null ? null : Number(stats.toneSt.toFixed(1)),
      variacion_semitonos: stats.spreadSt === null ? null : Number(stats.spreadSt.toFixed(1)),
      segundos_hablando: stats.seconds,
    },
  });
  const out = parse<{ nota?: string; consejo?: string }>(await send(system, user, 400));
  return { note: (out.nota ?? "").trim(), tip: (out.consejo ?? "").trim() };
}

/** Clave estable por contenido, para no volver a pedir los tonos del mismo guion. */
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
