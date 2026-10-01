import { describe, expect, test } from "bun:test";
import { Announcer, isHeadphones } from "./voice";

describe("isHeadphones", () => {
  test("reconoce auriculares por el nombre de la salida", () => {
    expect(isHeadphones("Headphones (AirPods Pro)")).toBe(true);
    expect(isHeadphones("Auriculares (Realtek(R) Audio)")).toBe(true);
    expect(isHeadphones("Speakers (HyperX Quadcast)")).toBe(true);
    expect(isHeadphones("Headset (Galaxy Buds2)")).toBe(true);
  });

  test("parlantes y monitores no", () => {
    expect(isHeadphones("Speakers (Realtek(R) Audio)")).toBe(false);
    expect(isHeadphones("MS306 (NVIDIA High Definition Audio)")).toBe(false);
    expect(isHeadphones(null)).toBe(false);
  });
});

describe("Announcer", () => {
  test("espera una pausa para hablar", () => {
    const a = new Announcer({ quietMs: 400, staleMs: 7_000, gapMs: 2_000 });
    a.push("Más lento", 0);
    expect(a.tick(0, true)).toBeNull();
    expect(a.tick(200, false)).toBeNull();
    expect(a.tick(500, false)).toBe("Más lento");
    expect(a.tick(600, false)).toBeNull();
  });

  test("se queda con el último y descarta lo viejo", () => {
    const a = new Announcer({ quietMs: 400, staleMs: 7_000, gapMs: 2_000 });
    a.push("Más lento", 0);
    a.push("Fuera de foco", 100);
    expect(a.tick(1_000, false)).toBe("Fuera de foco");
    a.done(1_500);

    a.push("Más fuerte", 2_000);
    for (let t = 2_000; t < 9_500; t += 100) expect(a.tick(t, true)).toBeNull();
    expect(a.tick(10_000, false)).toBeNull();
  });

  test("deja aire entre dos frases y no habla encima de sí misma", () => {
    const a = new Announcer({ quietMs: 400, staleMs: 7_000, gapMs: 2_000 });
    a.push("Uno", 0);
    expect(a.tick(500, false)).toBe("Uno");
    a.push("Dos", 600);
    expect(a.tick(1_000, false)).toBeNull();
    a.done(1_200);
    expect(a.tick(2_000, false)).toBeNull();
    expect(a.tick(3_300, false)).toBe("Dos");
  });
});
