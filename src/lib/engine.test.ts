import { describe, expect, test } from "bun:test";
import { keytermsOf, speed, splitShare } from "./engine";
import { parseScript } from "./script";

describe("keytermsOf", () => {
  test("claves primero, después títulos, sin repetir", () => {
    const doc = parseScript("# Gancho\n## JobIt\nclaves: jobit, learn it, JobIt\n- Viñeta\n## Demo\nclaves: mcp, eme ce pe\n");
    expect(keytermsOf(doc)).toEqual(["jobit", "learn it", "mcp", "eme ce pe", "Demo"]);
  });

  test("respeta los límites de xAI", () => {
    const points = Array.from({ length: 120 }, (_, i) => `## Punto ${i}\nclaves: ${"x".repeat(70)}${i}`).join("\n");
    const terms = keytermsOf(parseScript(`# S\n${points}`));
    expect(terms).toHaveLength(100);
    expect(terms.every((t) => t.length <= 50)).toBe(true);
  });
});

describe("speed", () => {
  test("dice si alcanza para ir en vivo", () => {
    expect(speed(0.03, 0.5)).toBe("33 veces más rápido que en vivo");
    expect(speed(0.8, 0.5)).toBe("demasiado lento para ir en vivo");
    expect(speed(null, 0.5)).toBe("no anduvo");
  });
});

describe("splitShare", () => {
  test("separa dirección y clave de lo copiado", () => {
    expect(splitShare("https://pc.tailnet.ts.net:5191\nabc123\n")).toEqual({ url: "https://pc.tailnet.ts.net:5191", key: "abc123" });
    expect(splitShare("  https://pc.ts.net:5191  abc123 ")).toEqual({ url: "https://pc.ts.net:5191", key: "abc123" });
  });

  test("un solo dato o más de dos no se separa", () => {
    expect(splitShare("https://pc.ts.net:5191")).toBeNull();
    expect(splitShare("a b c")).toBeNull();
    expect(splitShare("")).toBeNull();
  });
});
