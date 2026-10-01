import { describe, expect, test } from "bun:test";
import { describeFormat, phoneTakeBase, pickFormat, takeName, toBase64 } from "./recorder";

describe("pickFormat", () => {
  const all = () => true;

  test("MKV prefiere H.264 con PCM", () => {
    expect(pickFormat("mkv", all)).toEqual({ mime: "video/x-matroska;codecs=avc1.640028,pcm", ext: "mkv" });
  });

  test("MP4 prefiere H.264 con AAC", () => {
    expect(pickFormat("mp4", all)?.mime).toBe("video/mp4;codecs=avc1.640028,mp4a.40.2");
  });

  test("sin el pedido, cae al otro contenedor y después a WebM", () => {
    expect(pickFormat("mkv", (t) => t.startsWith("video/mp4"))?.ext).toBe("mp4");
    expect(pickFormat("mp4", (t) => t.startsWith("video/webm"))?.ext).toBe("webm");
    expect(pickFormat("mp4", () => false)).toBeNull();
  });
});

test("toBase64 deja los bytes tal cual, incluidos los que no son texto", async () => {
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 131) % 256);
  const b64 = await toBase64(new Blob([bytes]));
  expect(new Uint8Array(Buffer.from(b64, "base64"))).toEqual(bytes);
});

test("describeFormat", () => {
  expect(describeFormat("video/x-matroska;codecs=avc1.640028,pcm")).toBe("H.264 + audio PCM sin compresión");
  expect(describeFormat("video/mp4;codecs=avc1,mp4a.40.2")).toBe("H.264 + audio AAC");
});

test("takeName usa la hora local y un nombre que Rust acepta", () => {
  const name = takeName(new Date(2026, 8, 30, 9, 5, 7), "mkv");
  expect(name).toBe("toma-2026-09-30_09-05-07.mkv");
  expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
});

test("la toma del iPhone se llama como la de la PC", () => {
  const at = new Date(2026, 8, 30, 9, 5, 7);
  expect(phoneTakeBase(at)).toBe("toma-2026-09-30_09-05-07-iphone");
  expect(takeName(at, "mkv").startsWith(phoneTakeBase(at).replace("-iphone", ""))).toBe(true);
});
