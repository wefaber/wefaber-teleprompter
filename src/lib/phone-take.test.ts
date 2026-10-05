import { describe, expect, test } from "bun:test";
import { phoneFormats, Uploader, type PostResult } from "./phone-take";

const blob = (s: string) => new Blob([s]);

describe("phoneFormats", () => {
  test("MP4 primero, después WebM", () => {
    expect(phoneFormats((m) => m === "video/mp4" || m === "video/webm").map((f) => f.ext)).toEqual(["mp4", "webm"]);
    expect(phoneFormats((m) => m.startsWith("video/webm"))[0]?.ext).toBe("webm");
    expect(phoneFormats(() => false)).toEqual([]);
  });
});

describe("Uploader", () => {
  test("sube en orden y reintenta sin repetir", async () => {
    const got: [number, string][] = [];
    let fails = 2;
    const up = new Uploader({
      post: async (seq, chunk): Promise<PostResult> => {
        if (seq === 1 && fails-- > 0) return { retry: "sin red" };
        got.push([seq, await chunk.text()]);
        return { ok: true };
      },
      wait: async () => {},
    });
    up.push(blob("a"));
    up.push(blob("bb"));
    up.push(blob("ccc"));
    expect(await up.close()).toEqual({ chunks: 3, bytes: 6, error: null });
    expect(got).toEqual([
      [0, "a"],
      [1, "bb"],
      [2, "ccc"],
    ]);
  });

  test("mientras graba no se rinde; terminada, sí", async () => {
    let t = 0;
    let posts = 0;
    const up = new Uploader({
      post: async () => {
        posts += 1;
        return { retry: "sin red" };
      },
      // Cede al event loop como el setTimeout de verdad.
      wait: (ms) => {
        t += ms;
        return new Promise((r) => setTimeout(r, 0));
      },
      now: () => t,
      giveUpMs: 10_000,
    });
    let ended = false;
    void up.done.then(() => (ended = true));
    up.push(blob("a"));
    // El doble del tope, en tiempo simulado, todavía grabando.
    while (t < 20_000) await new Promise((r) => setTimeout(r, 1));
    expect(ended).toBe(false);
    expect(posts).toBeGreaterThan(4);
    const r = await up.close();
    expect(r.error).toContain("sin red");
    expect(r.chunks).toBe(0);
  });

  test("si la PC cerró la toma, avisa y corta", async () => {
    let gone = false;
    const up = new Uploader({ post: async () => ({ gone: true }), onGone: () => (gone = true) });
    up.push(blob("a"));
    const r = await up.done;
    expect(gone).toBe(true);
    expect(r.error).toBe("La PC cerró la toma");
    up.push(blob("b"));
    expect(up.pending).toBe(0);
  });

  test("informa el avance", async () => {
    const seen: [number, number][] = [];
    const up = new Uploader({ post: async () => ({ ok: true }), onProgress: (b, p) => seen.push([b, p]) });
    up.push(blob("ab"));
    up.push(blob("c"));
    await up.close();
    expect(seen.at(-1)).toEqual([3, 0]);
  });
});
