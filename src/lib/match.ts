/**
 * Sigue por dónde va la charla sin leer palabra por palabra.
 *
 * Cada punto tiene claves (explícitas, del título y de las viñetas). Lo que se
 * dice en los últimos segundos se compara con el punto actual y con los que
 * vienen cerca: si claramente se está hablando de uno de adelante, se salta
 * ahí. Las viñetas del punto actual se tachan a medida que se nombran.
 */

import type { Doc } from "./script";

const STOP = new Set(
  (
    "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun cada casi como con contra cual " +
    "cuales cuando de del desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta " +
    "estan estar este esto estos fue fueron ha hace hacen hacer hasta hay la las le les lo los mas me mi mis " +
    "mucho muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque que quien se sea ser " +
    "si sin sobre solo son su sus tambien te tiene tienen todo todos tu tus un una unas uno unos va vamos vos " +
    "ya yo eso bueno entonces digamos tipo osea cosa cosas ahi aca"
  ).split(" "),
);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Raíz corta: alcanza para que plurales, género y conjugaciones coincidan. */
export function stem(word: string): string {
  return word.length <= 5 ? word : word.slice(0, 5);
}

function contentStems(text: string): string[] {
  return words(text)
    .filter((w) => !STOP.has(w) && (w.length >= 4 || /\d/.test(w)))
    .map(stem);
}

type Key = { stems: string[]; weight: number; bullet: number | null };

export type PointIndex = { keys: Key[]; bullets: string[][] };

export function buildIndex(doc: Doc): PointIndex[] {
  const raw = doc.points.map((p, pi) => {
    const keys: Key[] = [];
    // Nombrar la sección ("ahora, privacidad") lleva a su primer punto.
    const section = doc.sections[p.section];
    if (section && section.first === pi && section.title !== p.title) {
      for (const s of contentStems(section.title)) keys.push({ stems: [s], weight: 2, bullet: null });
    }
    for (const k of p.keys) {
      const stems = words(k).map(stem);
      if (stems.length) keys.push({ stems, weight: 3, bullet: null });
    }
    for (const s of contentStems(p.title)) keys.push({ stems: [s], weight: 2, bullet: null });
    const bullets = p.bullets.map((b) => contentStems(b));
    bullets.forEach((stems, bi) => {
      for (const s of stems) keys.push({ stems: [s], weight: 1, bullet: bi });
    });
    return { keys, bullets };
  });

  // Una clave que aparece en muchos puntos dice poco de cuál es.
  const df = new Map<string, number>();
  for (const p of raw) {
    for (const id of new Set(p.keys.map((k) => k.stems.join(" ")))) df.set(id, (df.get(id) ?? 0) + 1);
  }
  const n = Math.max(raw.length, 1);
  const norm = Math.log(1 + n);
  return raw.map((p) => ({
    bullets: p.bullets,
    keys: dedupe(
      p.keys.map((k) => ({
        ...k,
        weight: (k.weight * Math.log(1 + n / (df.get(k.stems.join(" ")) ?? 1))) / norm,
      })),
    ),
  }));
}

/** La misma raíz puede salir del título y de una viñeta: queda la de más peso. */
function dedupe(keys: Key[]): Key[] {
  const best = new Map<string, Key>();
  for (const k of keys) {
    const id = k.stems.join(" ");
    const prev = best.get(id);
    if (!prev || k.weight > prev.weight) best.set(id, k);
  }
  return [...best.values()];
}

/** Una palabra oída, con cuánto pesa todavía (1 recién dicha, tiende a 0). */
export type Fresh = { stem: string; w: number };

/** El peso más alto con que aparece la secuencia, o 0 si no aparece. */
function freshness(heard: Fresh[], seq: string[]): number {
  let best = 0;
  outer: for (let i = 0; i + seq.length <= heard.length; i++) {
    for (let j = 0; j < seq.length; j++) if (heard[i + j]!.stem !== seq[j]) continue outer;
    best = Math.max(best, heard[i]!.w);
  }
  return best;
}

/** Una clave cuenta como "oída ahora" si todavía pesa más que esto. */
const LIVE = 0.35;

export function score(index: PointIndex, heard: Fresh[]): { score: number; hits: number } {
  let total = 0;
  let hits = 0;
  for (const k of index.keys) {
    const w = freshness(heard, k.stems);
    total += k.weight * w;
    if (w >= LIVE) hits++;
  }
  return { score: total, hits };
}

export type Sensitivity = "baja" | "media" | "alta";

const LEVELS: Record<Sensitivity, { hits: number; threshold: number }> = {
  baja: { hits: 3, threshold: 3.5 },
  media: { hits: 2, threshold: 2.2 },
  alta: { hits: 1, threshold: 1.4 },
};

/** Cuánto se cree un salto según la distancia: el siguiente es lo natural. */
const REACH: [number, number][] = [
  [1, 1],
  [2, 0.72],
  [3, 0.58],
  [-1, 0.5],
];

type Heard = { stem: string; t: number };

export type TrackerOptions = {
  sensitivity: Sensitivity;
  auto: boolean;
  windowMs: number;
  minDwellMs: number;
};

export const DEFAULT_TRACKER: TrackerOptions = {
  sensitivity: "media",
  auto: true,
  windowMs: 14_000,
  minDwellMs: 2_500,
};

export type Snapshot = { index: number; covered: ReadonlySet<number> };

/** Tiempo máximo entre las dos frases que confirman un salto. */
const CONFIRM_MS = 12_000;

export class Tracker {
  private idx: PointIndex[];
  private sections: number[];
  private heard: Heard[] = [];
  private interim: string[] = [];
  /** La última frase cerrada: un voto tiene que salir de ella, no de la ventana. */
  private last: string[] = [];
  /** Desde cuándo lo dicho cuenta para el punto actual. */
  private since = 0;
  /** Cuándo se llegó al punto actual; frena saltos en cadena. */
  private entered = 0;
  /** Un salto con un voto: espera otra frase que apunte al mismo lugar. */
  private pending: { index: number; t: number } | null = null;
  index = 0;
  covered = new Set<number>();

  options: TrackerOptions;

  constructor(doc: Doc, options: TrackerOptions = DEFAULT_TRACKER) {
    this.idx = buildIndex(doc);
    this.sections = doc.points.map((p) => p.section);
    this.options = options;
  }

  get length(): number {
    return this.idx.length;
  }

  /** Salto a mano: lo dicho antes no cuenta para el punto nuevo. */
  jump(index: number, now: number): void {
    const next = Math.max(0, Math.min(this.idx.length - 1, index));
    if (next === this.index) return;
    this.index = next;
    this.since = now;
    this.entered = now;
    this.covered = new Set();
    this.interim = [];
    this.pending = null;
  }

  final(text: string, now: number): Snapshot {
    this.last = words(text).map(stem);
    for (const s of this.last) this.heard.push({ stem: s, t: now });
    this.interim = [];
    // Nada de lo que tenga más de un minuto vuelve a servir.
    const cutoff = now - 60_000;
    if (this.heard.length && this.heard[0]!.t < cutoff) this.heard = this.heard.filter((h) => h.t >= cutoff);
    return this.evaluate(now, true);
  }

  partial(text: string, now: number): Snapshot {
    this.interim = words(text).map(stem);
    return this.evaluate(now, false);
  }

  private heardSince(from: number): string[] {
    return [...this.heard.filter((h) => h.t >= from).map((h) => h.stem), ...this.interim];
  }

  private done(): boolean {
    const current = this.idx[this.index];
    return !!current && current.bullets.length > 0 && this.covered.size >= current.bullets.length;
  }

  /**
   * Solo el siguiente, dentro de la misma sección (o con el punto actual ya
   * dicho entero), avanza con una frase. Todo lo demás pide confirmación.
   */
  private immediate(target: number): boolean {
    if (target !== this.index + 1) return false;
    return this.sections[target] === this.sections[this.index] || this.done();
  }

  /**
   * Lo que se dice para las viñetas y para decidir. Los parciales de una
   * misma frase llegan varias veces: solo las frases cerradas votan.
   */
  evaluate(now: number, isFinal = false): Snapshot {
    const current = this.idx[this.index];
    if (!current) return this.snapshot();

    // Viñetas: se acumulan desde que se entró al punto.
    const sincePoint = this.heardSince(this.since);
    current.bullets.forEach((stems, bi) => {
      if (this.covered.has(bi) || stems.length === 0) return;
      const need = Math.min(2, Math.max(1, Math.ceil(stems.length * 0.4)));
      const got = new Set(stems.filter((s) => sincePoint.includes(s))).size;
      if (got >= need) this.covered.add(bi);
    });

    if (!this.options.auto || now - this.entered < this.options.minDwellMs) return this.snapshot();

    // Lo recién dicho pesa entero y se apaga en unos segundos: el cambio de
    // tema se nota aunque antes se haya hablado mucho del punto actual.
    const tau = this.options.windowMs / 3;
    const recent: Fresh[] = [
      ...this.heard
        .filter((h) => h.t >= this.since && now - h.t <= this.options.windowMs)
        .map((h) => ({ stem: h.stem, w: Math.exp(-(now - h.t) / tau) })),
      ...this.interim.map((stem) => ({ stem, w: 1 })),
    ];
    const level = LEVELS[this.options.sensitivity];
    const done = this.done();
    // Un punto ya dicho entero retiene menos: lo natural es que se termine.
    const here = score(current, recent).score * (done ? 0.5 : 1);

    const pick = (targets: { index: number; reach: number; hits: number; threshold: number }[]) => {
      let best: { index: number; value: number } | null = null;
      for (const t of targets) {
        const cand = this.idx[t.index];
        if (!cand) continue;
        const { score: s, hits } = score(cand, recent);
        const value = s * t.reach;
        // La distancia pesa para elegir entre candidatos, no para ganarle al actual.
        if (hits < t.hits || value < t.threshold || s <= here * 1.2) continue;
        if (!best || value > best.value) best = { index: t.index, value };
      }
      return best;
    };

    const near = REACH.map(([offset, reach]) => {
      // Con todo lo del punto dicho, pasar al siguiente pide menos.
      const easy = offset === 1 && done;
      return {
        index: this.index + offset,
        reach,
        hits: easy ? Math.max(1, level.hits - 1) : level.hits,
        threshold: easy ? level.threshold * 0.6 : level.threshold,
      };
    });
    // Lejos solo hacia adelante y con evidencia clara: cambiar de tema de
    // golpe pasa, pero volver atrás varios puntos casi siempre es una mención.
    const far = this.idx
      .map((_, i) => ({ index: i, reach: 1, hits: level.hits + 2, threshold: level.threshold * 1.8 }))
      .filter((t) => t.index > this.index + 3);

    const best = pick(near) ?? pick(far);
    if (!best) return this.snapshot();
    if (this.immediate(best.index)) return this.move(best.index, now);
    return isFinal && this.supports(best.index) ? this.vote(best.index, now) : this.snapshot();
  }

  /**
   * La frase recién cerrada, sola, habla más del destino que del punto
   * actual. Si no, lo que empuja es un resto de la ventana: una mención de
   * hace un rato no se confirma a sí misma.
   */
  private supports(target: number): boolean {
    const cand = this.idx[target];
    const current = this.idx[this.index];
    if (!cand || !current) return false;
    const fresh: Fresh[] = this.last.map((stem) => ({ stem, w: 1 }));
    const there = score(cand, fresh);
    return there.hits >= 1 && there.score > score(current, fresh).score;
  }

  /**
   * Una opinión de afuera (DeepSeek, por el sentido). Vota igual que una
   * frase: el siguiente pasa solo, lo demás necesita que otra frase coincida.
   */
  propose(target: number, now: number): Snapshot {
    const offset = target - this.index;
    if (!this.options.auto || offset === 0 || offset < -1 || offset > 3) return this.snapshot();
    if (now - this.entered < this.options.minDwellMs) return this.snapshot();
    if (this.immediate(target)) return this.move(target, now);
    return this.vote(target, now);
  }

  private vote(target: number, now: number): Snapshot {
    const p = this.pending;
    if (p && p.index === target && now - p.t <= CONFIRM_MS && now > p.t) return this.move(target, now);
    this.pending = { index: target, t: now };
    return this.snapshot();
  }

  private move(target: number, now: number): Snapshot {
    this.index = target;
    // Lo último que se dijo es del punto nuevo: sirve para sus viñetas.
    this.since = now - 5_000;
    this.entered = now;
    this.covered = new Set();
    this.pending = null;
    return this.evaluate(now);
  }

  /** Viñetas del punto actual que se dijeron con otras palabras. */
  cover(bullets: number[]): Snapshot {
    const count = this.idx[this.index]?.bullets.length ?? 0;
    for (const b of bullets) if (b >= 0 && b < count) this.covered.add(b);
    return this.snapshot();
  }

  snapshot(): Snapshot {
    return { index: this.index, covered: new Set(this.covered) };
  }
}
