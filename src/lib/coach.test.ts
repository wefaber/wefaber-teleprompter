import { describe, expect, test } from "bun:test";
import { Coach, type Utterance } from "./coach";

const u = (t: number, over: Partial<Utterance> = {}): Utterance => ({
  t,
  words: 12,
  speechS: 4.5, // 160 palabras por minuto
  f0Hz: 120,
  spreadSt: 2.5,
  levelDb: -20,
  section: 0,
  ...over,
});

/** Seis frases normales para fijar la base. */
function warmed(): Coach {
  const c = new Coach();
  for (let i = 0; i < 6; i++) c.push(u(i * 5_000));
  return c;
}

describe("Coach", () => {
  test("a ritmo normal no dice nada", () => {
    const c = warmed();
    expect(c.push(u(31_000))).toBeNull();
    expect(c.live(31_000).wpm).toBe(160);
  });

  test("avisa cuando vas rápido", () => {
    const c = new Coach();
    let hint = null;
    for (let i = 0; i < 4 && !hint; i++) hint = c.push(u(i * 4_000, { words: 17, speechS: 4 }));
    expect(hint?.kind).toBe("ritmo");
    expect(hint?.text).toContain("rápido");
  });

  test("el tono se mide contra tu base", () => {
    const c = warmed();
    let hint = null;
    let t = 60_000;
    for (let i = 0; i < 6 && !hint; i++, t += 5_000) hint = c.push(u(t, { f0Hz: 150 }));
    expect(hint?.kind).toBe("tono");
    expect(c.live(t).toneSt ?? 0).toBeGreaterThan(3);
  });

  test("sin base todavía, el tono no opina", () => {
    const c = new Coach();
    const hint = c.push(u(0, { f0Hz: 300, speechS: 9, words: 24 }));
    expect(hint).toBeNull();
    expect(c.live(0).toneSt).toBeNull();
  });

  test("detecta la voz plana", () => {
    const c = new Coach();
    let hint = null;
    for (let i = 0; i < 4 && !hint; i++) hint = c.push(u(i * 5_000, { spreadSt: 0.6 }));
    expect(hint?.kind).toBe("expresion");
  });

  test("no repite el mismo consejo seguido", () => {
    const c = new Coach();
    const hints = [];
    for (let i = 0; i < 12; i++) hints.push(c.push(u(i * 4_000, { words: 17, speechS: 4 })));
    expect(hints.filter((h) => h?.kind === "ritmo").length).toBe(1);
  });

  test("resume por sección", () => {
    const c = warmed();
    c.push(u(40_000, { section: 1, words: 10, speechS: 5 }));
    c.push(u(45_000, { section: 1, words: 10, speechS: 5 }));
    expect(c.summary(1)).toMatchObject({ wpm: 120, seconds: 10 });
  });
});
