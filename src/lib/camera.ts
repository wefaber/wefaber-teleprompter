/**
 * Mirar la imagen de la cámara y avisar lo que se arregla antes de grabar:
 * luz, contraluz, lente sucia, foco y color. Todo corre en la PC sobre un
 * cuadro chico cada un par de segundos; no se guarda ni se manda nada.
 */

export type Aspect = "9:16" | "4:5" | "1:1" | "16:9";
export type Rotation = 0 | 90 | 180 | 270;

export const ASPECTS: Aspect[] = ["16:9", "9:16", "4:5", "1:1"];

/** Tamaños que se prueban para abrir la cámara, del más común al menos. */
export const CAPTURE_MODES = ["1920x1080", "1280x720", "640x480", "960x720", "2560x1440"] as const;

export function parseMode(mode: string): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(mode);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** El orden de prueba: primero el preferido, después el resto, sin repetir. */
export function modeOrder(preferred: string[]): string[] {
  return [...new Set([...preferred.filter((m) => parseMode(m)), ...CAPTURE_MODES])];
}

/** Ancho sobre alto de lo que se ve. */
export function ratio(a: Aspect): number {
  const [w, h] = a.split(":").map(Number) as [number, number];
  return w / h;
}

/**
 * La parte de la imagen original que queda a la vista con ese formato y esa
 * rotación: el recorte más grande, centrado.
 */
export function cropRect(srcW: number, srcH: number, aspect: Aspect, rotate: Rotation) {
  const shown = ratio(aspect);
  // Rotada un cuarto de vuelta, el ancho que se ve es el alto de la fuente.
  const want = rotate === 90 || rotate === 270 ? 1 / shown : shown;
  let w = srcW;
  let h = srcW / want;
  if (h > srcH) {
    h = srcH;
    w = srcH * want;
  }
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h };
}

export type Frame = { data: Uint8ClampedArray; width: number; height: number };

export type FrameStats = {
  /** Luz media, 0 a 255. */
  mean: number;
  /** Parte del cuadro en el verde de un YUV vacío: la cámara no manda nada. */
  empty: number;
  p2: number;
  p98: number;
  /** Parte de la imagen quemada (casi blanca). */
  clipped: number;
  /** El negro más oscuro que hay: con la lente engrasada nunca llega abajo. */
  floor: number;
  /** Centro (donde va la cara) contra el borde. */
  center: number;
  border: number;
  /** Bordes nítidos respecto del contraste: baja con la imagen blanda. */
  sharpness: number;
  /** Rojo menos azul en lo claro del fondo: + cálido, − frío. */
  warmth: number;
};

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Un búfer YUV en ceros se ve verde puro (más o menos 0, 135, 0). Es lo que
 * entrega una cámara virtual como DroidCam cuando se le pide un tamaño que
 * no es el que está sacando.
 */
function emptyGreen(r: number, g: number, b: number): boolean {
  return g > 90 && r < 50 && b < 50 && g - Math.max(r, b) > 70;
}

/** El cuadro entero es ese verde: no hay imagen, aunque la cámara abra. */
export function isEmptyFrame({ data, width, height }: Frame): boolean {
  const n = width * height;
  let hits = 0;
  for (let i = 0; i < n; i++) if (emptyGreen(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!)) hits++;
  return n > 0 && hits / n > 0.9;
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

export function analyzeFrame({ data, width, height }: Frame): FrameStats {
  const n = width * height;
  const y = new Float32Array(n);
  const hist = new Uint32Array(256);
  const borderHist = new Uint32Array(256);
  const floorHist = new Uint32Array(256);
  let sum = 0;
  let clipped = 0;
  let empty = 0;
  let center = 0;
  let centerN = 0;
  let border = 0;
  let borderN = 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const r = data[i * 4]!;
      const g = data[i * 4 + 1]!;
      const b = data[i * 4 + 2]!;
      const l = luma(r, g, b);
      y[i] = l;
      sum += l;
      hist[Math.min(255, Math.round(l))]!++;
      floorHist[Math.min(r, g, b)]!++;
      if (l >= 250) clipped++;
      if (emptyGreen(r, g, b)) empty++;
      const fx = col / width;
      const fy = row / height;
      if (fx >= 0.3 && fx < 0.7 && fy >= 0.25 && fy < 0.75) {
        center += l;
        centerN++;
      } else if (fx < 0.15 || fx >= 0.85 || fy < 0.15 || fy >= 0.85) {
        border += l;
        borderN++;
        borderHist[Math.min(255, Math.round(l))]!++;
      }
    }
  }

  const p2 = percentile(hist, n, 0.02);
  const p98 = percentile(hist, n, 0.98);
  const light = percentile(borderHist, borderN, 0.75);

  // Color en lo claro del fondo, lejos de la cara: la piel tira siempre a
  // cálido y, con el monitor de frente, suele ser lo más claro del cuadro.
  let wr = 0;
  let wb = 0;
  let wl = 0;
  for (let i = 0; i < n; i++) {
    const fx = (i % width) / width;
    const fy = Math.floor(i / width) / height;
    if (!(fx < 0.15 || fx >= 0.85 || fy < 0.15 || fy >= 0.85)) continue;
    const l = y[i]!;
    if (l < light || l >= 245) continue;
    wr += data[i * 4]!;
    wb += data[i * 4 + 2]!;
    wl += l;
  }

  // Gradiente: el percentil 99 son los bordes más marcados (ojos, pelo,
  // ropa). Enfocado, un borde cruza todo el contraste en uno o dos píxeles.
  const grads = new Uint32Array(256);
  let gn = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      const gx = y[i + 1]! - y[i - 1]!;
      const gy = y[i + width]! - y[i - width]!;
      grads[Math.min(255, Math.round(Math.hypot(gx, gy) / 2))]!++;
      gn++;
    }
  }
  const edge = gn ? percentile(grads, gn, 0.99) : 0;

  return {
    mean: n ? sum / n : 0,
    empty: n ? empty / n : 0,
    p2,
    p98,
    clipped: n ? clipped / n : 0,
    floor: percentile(floorHist, n, 0.03),
    center: centerN ? center / centerN : 0,
    border: borderN ? border / borderN : 0,
    sharpness: edge / Math.max(24, p98 - p2),
    warmth: wl ? (wr - wb) / wl : 0,
  };
}

export type CameraHint = { id: CameraIssue; text: string; say: string };

export type CameraIssue = "sin-imagen" | "oscuro" | "quemado" | "contraluz" | "lente" | "foco" | "calido" | "frio";

export type CameraContext = { brightness: number };

type Rule = {
  id: CameraIssue;
  test: (s: FrameStats) => boolean;
  text: (c: CameraContext) => string;
  /** Para la voz: dos o tres palabras. */
  say: string;
  /** Cada cuánto puede repetirse, si no es el de siempre. */
  repeatMs?: number;
};

/** En orden: si falta luz, lo demás no se puede juzgar. */
const RULES: Rule[] = [
  {
    id: "sin-imagen",
    test: (s) => (s.mean < 6 && s.p98 < 12) || s.empty > 0.9,
    say: "Se cortó la cámara",
    text: () => "La cámara no manda imagen. Revisá que DroidCam esté conectado y no hayas cambiado su resolución.",
  },
  {
    id: "oscuro",
    test: (s) => s.center < 70 && s.mean < 85,
    say: "Falta luz",
    text: (c) =>
      c.brightness < 95
        ? `Falta luz en la cara. Subí el brillo de la pantalla (está en ${c.brightness}%) o acercate.`
        : "Falta luz en la cara. Acercate a la pantalla o sumá una luz de frente.",
  },
  {
    id: "quemado",
    test: (s) => s.clipped > 0.08,
    say: "Imagen quemada",
    text: (c) =>
      c.brightness > 70
        ? "Hay partes quemadas. Bajá un poco el brillo o alejate de la luz."
        : "Hay partes quemadas. Alejate de la luz o bajá la exposición en DroidCam.",
  },
  {
    id: "contraluz",
    test: (s) => s.border - s.center > 55 && s.center < 120,
    say: "Estás a contraluz",
    text: () => "Estás a contraluz: lo de atrás tiene más luz que tu cara. Cerrá la cortina o girá la cámara.",
  },
  {
    id: "lente",
    test: (s) => s.floor > 48 && s.p98 - s.p2 < 165 && s.mean < 215,
    say: "Limpiá la lente",
    text: () => "La imagen sale lavada, como con niebla. Limpiá la lente del teléfono con un paño.",
  },
  {
    id: "foco",
    test: (s) => s.sharpness < 0.12 && s.p98 - s.p2 > 60,
    say: "Fuera de foco",
    text: () => "La imagen está blanda. Tocá tu cara en el teléfono para enfocar, o limpiá la lente.",
  },
  {
    id: "calido",
    test: (s) => s.warmth > 0.3,
    say: "Fondo muy cálido",
    text: () => "El fondo tira a naranja. Si no es a propósito, probá la luz Neutro o Blanco.",
    repeatMs: 300_000,
  },
  {
    id: "frio",
    test: (s) => s.warmth < -0.18,
    say: "Fondo muy frío",
    text: () => "El fondo tira a azul. Si no es a propósito, probá la luz Neutro o Cálido.",
    repeatMs: 300_000,
  },
];

export type CameraCoachOptions = {
  /** Cuántos cuadros se miran para decidir. */
  window: number;
  /** Cuántos de esos tienen que mostrar el problema. */
  agree: number;
  /** Cuánto esperar para repetir el mismo aviso. */
  repeatMs: number;
  /** Cuánto esperar entre avisos de cámara. */
  gapMs: number;
};

export const DEFAULT_CAMERA_COACH: CameraCoachOptions = { window: 5, agree: 4, repeatMs: 90_000, gapMs: 20_000 };

/**
 * Decide sobre varios cuadros seguidos: un gesto, una mano delante o un
 * cambio de exposición no alcanzan para avisar.
 */
export class CameraCoach {
  private recent: FrameStats[] = [];
  private last = new Map<CameraIssue, number>();
  private lastAny = -Infinity;
  options: CameraCoachOptions;

  constructor(options: CameraCoachOptions = DEFAULT_CAMERA_COACH) {
    this.options = options;
  }

  push(stats: FrameStats, now: number, context: CameraContext): CameraHint | null {
    this.recent.push(stats);
    if (this.recent.length > this.options.window) this.recent.shift();
    if (this.recent.length < this.options.window) return null;
    if (now - this.lastAny < this.options.gapMs) return null;

    for (const rule of RULES) {
      const seen = this.recent.filter(rule.test).length;
      if (seen < this.options.agree) continue;
      // El primer problema que se ve es el que manda, aunque se haya dicho hace poco.
      if (now - (this.last.get(rule.id) ?? -Infinity) < (rule.repeatMs ?? this.options.repeatMs)) return null;
      this.last.set(rule.id, now);
      this.lastAny = now;
      return { id: rule.id, text: rule.text(context), say: rule.say };
    }
    return null;
  }

  reset(): void {
    this.recent = [];
    this.last.clear();
    this.lastAny = -Infinity;
  }
}
