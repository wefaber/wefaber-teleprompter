/**
 * Consejos de voz a partir de cómo se dijo cada frase. El tono y el volumen se
 * comparan con tu propia base (los primeros minutos de la toma), no con un
 * número fijo: cada voz tiene su altura.
 */

export type Prosody = {
  speechS: number;
  f0Hz: number | null;
  spreadSt: number | null;
  levelDb: number;
};

export type Utterance = Prosody & { t: number; words: number; section: number };

export type HintKind = "ritmo" | "tono" | "expresion" | "volumen" | "seccion" | "punto" | "camara";

/** `say`: lo que dice la voz por los auriculares, corto para no tapar lo que decís. */
export type Hint = { kind: HintKind; text: string; t: number; say?: string };

export type Live = {
  wpm: number | null;
  toneSt: number | null;
  spreadSt: number | null;
  ready: boolean;
};

export type CoachOptions = {
  fastWpm: number;
  slowWpm: number;
  windowMs: number;
  /** Silencio mínimo entre dos consejos cualesquiera. */
  gapMs: number;
  /** Silencio mínimo entre dos consejos del mismo tipo. */
  repeatMs: number;
};

export const DEFAULT_COACH: CoachOptions = {
  fastWpm: 190,
  slowWpm: 105,
  windowMs: 25_000,
  gapMs: 15_000,
  repeatMs: 45_000,
};

/** Frases que alcanzan para fijar tu base de tono y volumen. */
const BASELINE_UTTERANCES = 6;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

export class Coach {
  private all: Utterance[] = [];
  private base: { f0: number; db: number } | null = null;
  private lastHint = -Infinity;
  private lastByKind = new Map<HintKind, number>();
  options: CoachOptions;

  constructor(options: CoachOptions = DEFAULT_COACH) {
    this.options = options;
  }

  get utterances(): readonly Utterance[] {
    return this.all;
  }

  reset(): void {
    this.all = [];
    this.base = null;
    this.lastHint = -Infinity;
    this.lastByKind.clear();
  }

  /** Suma una frase dicha y devuelve un consejo si hace falta uno. */
  push(u: Utterance): Hint | null {
    if (u.speechS < 0.6 || u.words === 0) return null;
    this.all.push(u);
    if (!this.base) {
      const withPitch = this.all.filter((x) => x.f0Hz !== null);
      if (withPitch.length >= BASELINE_UTTERANCES) {
        this.base = { f0: median(withPitch.map((x) => x.f0Hz!)), db: median(this.all.map((x) => x.levelDb)) };
      }
    }
    return this.decide(u.t);
  }

  live(now: number): Live {
    const w = this.window(now);
    return { wpm: wpm(w), toneSt: this.toneSt(w), spreadSt: spread(w), ready: this.base !== null };
  }

  /** Resumen de una sección, para la devolución de DeepSeek y las notas. */
  summary(section: number): { wpm: number | null; toneSt: number | null; spreadSt: number | null; seconds: number } {
    const us = this.all.filter((u) => u.section === section);
    return {
      wpm: wpm(us),
      toneSt: this.toneSt(us),
      spreadSt: spread(us),
      seconds: Math.round(us.reduce((a, u) => a + u.speechS, 0)),
    };
  }

  /** Para que una sugerencia de afuera (DeepSeek) respete los mismos tiempos. */
  allow(kind: HintKind, now: number): boolean {
    if (now - this.lastHint < this.options.gapMs) return false;
    if (now - (this.lastByKind.get(kind) ?? -Infinity) < this.options.repeatMs) return false;
    this.lastHint = now;
    this.lastByKind.set(kind, now);
    return true;
  }

  private window(now: number): Utterance[] {
    return this.all.filter((u) => u.t >= now - this.options.windowMs);
  }

  private toneSt(us: Utterance[]): number | null {
    if (!this.base) return null;
    const f0 = us.map((u) => u.f0Hz).filter((f): f is number => f !== null);
    if (f0.length < 2) return null;
    return 12 * Math.log2(median(f0) / this.base.f0);
  }

  private decide(now: number): Hint | null {
    const w = this.window(now);
    const talked = w.reduce((a, u) => a + u.speechS, 0);
    if (talked < 8) return null;

    const candidates: Hint[] = [];
    const rate = wpm(w);
    if (rate !== null && rate > this.options.fastWpm) {
      candidates.push({ kind: "ritmo", text: `Vas rápido: ${rate} palabras por minuto. Respirá entre ideas.`, say: "Más lento", t: now });
    } else if (rate !== null && rate < this.options.slowWpm) {
      candidates.push({ kind: "ritmo", text: `Vas lento: ${rate} palabras por minuto. Podés soltarte un poco.`, say: "Un poco más rápido", t: now });
    }

    const tone = this.toneSt(w);
    if (tone !== null && tone > 2.5) {
      candidates.push({
        kind: "tono",
        text: `Tono más alto que tu base (+${tone.toFixed(1)} semitonos). Bajalo y aflojá los hombros.`,
        say: "Bajá el tono",
        t: now,
      });
    }

    const sp = spread(w);
    if (sp !== null && sp < 1.3) {
      candidates.push({ kind: "expresion", text: "Voz plana: subí y bajá el tono para marcar lo importante.", say: "Más expresión", t: now });
    }

    if (this.base) {
      const db = median(w.map((u) => u.levelDb));
      if (db < this.base.db - 6) {
        candidates.push({ kind: "volumen", text: "Estás bajando el volumen. Proyectá hacia la cámara.", say: "Más fuerte", t: now });
      }
    }

    for (const h of candidates) if (this.allow(h.kind, now)) return h;
    return null;
  }
}

function wpm(us: Utterance[]): number | null {
  const secs = us.reduce((a, u) => a + u.speechS, 0);
  if (secs < 5) return null;
  return Math.round((us.reduce((a, u) => a + u.words, 0) / secs) * 60);
}

function spread(us: Utterance[]): number | null {
  const s = us.map((u) => u.spreadSt).filter((x): x is number => x !== null);
  if (s.length < 2) return null;
  return s.reduce((a, b) => a + b, 0) / s.length;
}
