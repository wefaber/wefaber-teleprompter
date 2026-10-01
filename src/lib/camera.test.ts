import { describe, expect, test } from "bun:test";
import { CameraCoach, analyzeFrame, cropRect, isEmptyFrame, modeOrder, type Frame, type FrameStats } from "./camera";

const W = 160;
const H = 120;

type RGB = [number, number, number];

/** Una toma de cara: pared gris, remera oscura, cara en el centro, pelo. */
function scene(): Frame {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      let c: RGB = [150, 150, 148];
      const dx = (col - W / 2) / 26;
      const dy = (row - H * 0.45) / 34;
      if (row > H * 0.78) c = [20, 22, 28];
      if (dx * dx + dy * dy < 1) c = row < H * 0.3 ? [30, 22, 18] : [196, 150, 125];
      // Una ventana clara arriba a la izquierda y un cuadro en la pared.
      if (col < 30 && row < 40) c = [215, 215, 212];
      if (col > 128 && row > 20 && row < 50) c = [60, 70, 90];
      data.set([...c, 255], (row * W + col) * 4);
    }
  }
  return { data, width: W, height: H };
}

function map(f: Frame, fn: (c: RGB, col: number, row: number) => RGB): Frame {
  const data = new Uint8ClampedArray(f.data.length);
  for (let i = 0; i < W * H; i++) {
    const c = fn([f.data[i * 4]!, f.data[i * 4 + 1]!, f.data[i * 4 + 2]!], i % W, Math.floor(i / W));
    data.set([...c, 255], i * 4);
  }
  return { data, width: W, height: H };
}

function blur(f: Frame, r: number): Frame {
  const data = new Uint8ClampedArray(f.data.length);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let y = Math.max(0, row - r); y <= Math.min(H - 1, row + r); y++) {
        for (let x = Math.max(0, col - r); x <= Math.min(W - 1, col + r); x++) {
          for (let k = 0; k < 3; k++) acc[k]! += f.data[(y * W + x) * 4 + k]!;
          n++;
        }
      }
      data.set([acc[0]! / n, acc[1]! / n, acc[2]! / n, 255], (row * W + col) * 4);
    }
  }
  return { data, width: W, height: H };
}

function verdict(stats: FrameStats, brightness = 100): string | null {
  const c = new CameraCoach();
  let out = null;
  for (let i = 0; i < 5; i++) out = c.push(stats, i * 1_500, { brightness });
  return out?.id ?? null;
}

describe("analyzeFrame", () => {
  test("una toma normal no tiene nada que decir", () => {
    expect(verdict(analyzeFrame(scene()))).toBeNull();
  });

  test("oscuro", () => {
    const s = analyzeFrame(map(scene(), (c) => c.map((v) => v * 0.3) as RGB));
    expect(verdict(s)).toBe("oscuro");
  });

  test("oscuro con la pantalla a medio brillo sugiere subirlo", () => {
    const s = analyzeFrame(map(scene(), (c) => c.map((v) => v * 0.3) as RGB));
    const c = new CameraCoach();
    let h = null;
    for (let i = 0; i < 5; i++) h = c.push(s, i * 1_500, { brightness: 60 });
    expect(h?.text).toContain("60%");
  });

  test("quemado", () => {
    const s = analyzeFrame(map(scene(), (c) => c.map((v) => v * 1.9) as RGB));
    expect(verdict(s)).toBe("quemado");
  });

  test("contraluz", () => {
    const s = analyzeFrame(
      map(scene(), (c, col, row) => {
        const edge = col < W * 0.15 || col >= W * 0.85 || row < H * 0.15;
        return edge ? [245, 245, 245] : (c.map((v) => v * 0.45) as RGB);
      }),
    );
    expect(verdict(s)).toBe("contraluz");
  });

  test("lente sucia: todo lavado", () => {
    const s = analyzeFrame(map(blur(scene(), 1), (c) => c.map((v) => v * 0.5 + 190 * 0.5) as RGB));
    expect(verdict(s)).toBe("lente");
  });

  test("fuera de foco", () => {
    const s = analyzeFrame(blur(scene(), 6));
    expect(s.sharpness).toBeLessThan(analyzeFrame(scene()).sharpness / 2);
    expect(verdict(s)).toBe("foco");
  });

  test("la cara bien iluminada no cuenta como color cálido", () => {
    // Monitor de frente: la cara es lo más claro del cuadro.
    const s = analyzeFrame(map(scene(), (c, col, row) => (col >= 30 || row >= 40 ? c : [120, 120, 118])));
    expect(s.warmth).toBeLessThan(0.1);
    expect(verdict(s)).toBeNull();
  });

  test("color cálido y frío", () => {
    expect(verdict(analyzeFrame(map(scene(), ([r, g, b]) => [r * 1.12, g * 0.95, b * 0.7])))).toBe("calido");
    expect(verdict(analyzeFrame(map(scene(), ([r, g, b]) => [r * 0.72, g * 0.95, b * 1.15])))).toBe("frio");
  });

  test("sin imagen", () => {
    expect(verdict(analyzeFrame(map(scene(), () => [0, 0, 0])))).toBe("sin-imagen");
  });

  test("el verde de un búfer vacío es sin imagen, una escena verde no", () => {
    const green = map(scene(), () => [0, 135, 0]);
    expect(isEmptyFrame(green)).toBe(true);
    expect(verdict(analyzeFrame(green))).toBe("sin-imagen");
    expect(isEmptyFrame(scene())).toBe(false);
    // Una pared verde de verdad tiene rojo y azul.
    expect(isEmptyFrame(map(scene(), ([r, g, b]) => [r * 0.5, Math.min(255, g * 1.2), b * 0.5]))).toBe(false);
  });
});

describe("CameraCoach", () => {
  const dark = analyzeFrame(map(scene(), (c) => c.map((v) => v * 0.3) as RGB));
  const fine = analyzeFrame(scene());

  test("un cuadro suelto no alcanza", () => {
    const c = new CameraCoach();
    const got = [fine, fine, fine, fine, dark].map((s, i) => c.push(s, i * 1_500, { brightness: 100 }));
    expect(got.every((h) => h === null)).toBe(true);
  });

  test("no repite el mismo aviso enseguida", () => {
    const c = new CameraCoach();
    const ids: (string | null)[] = [];
    for (let i = 0; i < 40; i++) ids.push(c.push(dark, i * 1_500, { brightness: 100 })?.id ?? null);
    expect(ids.filter(Boolean)).toEqual(["oscuro"]);
  });
});

describe("modeOrder", () => {
  test("prueba primero el que anduvo, sin repetir, e ignora basura", () => {
    const order = modeOrder(["1280x720", "", "nada"]);
    expect(order[0]).toBe("1280x720");
    expect(order.filter((m) => m === "1280x720")).toHaveLength(1);
    expect(order).toContain("1920x1080");
  });
});

describe("cropRect", () => {
  test("9:16 de una fuente apaisada toma el centro", () => {
    const r = cropRect(1280, 720, "9:16", 0);
    expect(r.h).toBe(720);
    expect(r.w).toBeCloseTo(405);
    expect(r.x).toBeCloseTo((1280 - 405) / 2);
  });

  test("rotada, 9:16 usa casi toda la fuente apaisada", () => {
    const r = cropRect(1280, 720, "9:16", 90);
    expect(r.w).toBe(1280);
    expect(r.h).toBe(720);
  });
});
