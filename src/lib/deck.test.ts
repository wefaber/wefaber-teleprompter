import { describe, expect, test } from "bun:test";
import { audienceState, mediaKind, pastEnd, resolveMedia } from "./deck";
import { parseScript } from "./script";

describe("mediaKind", () => {
  test("por extensión", () => {
    expect(mediaKind("a.PNG")).toBe("imagen");
    expect(mediaKind("intro.html")).toBe("html");
    expect(mediaKind("demo.mp4")).toBe("video");
    expect(mediaKind("notas.txt")).toBeNull();
  });
});

describe("resolveMedia", () => {
  test("relativa a la carpeta, con barras de Windows", () => {
    expect(resolveMedia("C:\\Charlas\\wegraph\\", "media/portada.png")).toBe("C:\\Charlas\\wegraph\\media\\portada.png");
    expect(resolveMedia("C:\\Charlas\\wegraph", "./portada.png")).toBe("C:\\Charlas\\wegraph\\portada.png");
  });

  test("una ruta absoluta queda como está", () => {
    expect(resolveMedia(undefined, "D:/videos/demo.mp4")).toBe("D:\\videos\\demo.mp4");
  });

  test("sin carpeta o saliendo de ella, null", () => {
    expect(resolveMedia(undefined, "portada.png")).toBeNull();
    expect(resolveMedia("C:\\Charlas", "../secreto.png")).toBeNull();
  });
});

describe("pastEnd", () => {
  test("solo con fin y pasado el fin", () => {
    expect(pastEnd(41, 40)).toBe(true);
    expect(pastEnd(39, 40)).toBe(false);
    expect(pastEnd(1_000, undefined)).toBe(false);
  });
});

describe("audienceState", () => {
  const doc = parseScript(`# A
## Portada
diapo: media/portada.png
- Quién soy
## Demo
video: media/demo.mp4 0:12-0:40 auto
## Texto
- Solo texto
## Falta
diapo: portada.png
`);
  const folder = "C:\\Charlas\\wegraph";

  test("imagen", () => {
    const s = audienceState(doc.points[0], folder, false, false);
    expect(s.slide).toEqual({ path: "C:\\Charlas\\wegraph\\media\\portada.png", kind: "imagen" });
    expect(s.video).toBeNull();
    expect(s.title).toBe("Portada");
  });

  test("video con su rango", () => {
    const s = audienceState(doc.points[1], folder, false, true);
    expect(s.video).toEqual({ path: "C:\\Charlas\\wegraph\\media\\demo.mp4", start: 12, end: 40 });
    expect(s.playing).toBe(true);
  });

  test("sin diapositiva: título y viñetas", () => {
    const s = audienceState(doc.points[2], folder, false, false);
    expect(s.slide).toBeNull();
    expect(s.bullets).toEqual(["Solo texto"]);
    expect(s.missing).toBeNull();
  });

  test("sin carpeta avisa qué falta", () => {
    expect(audienceState(doc.points[3], undefined, false, false).missing).toBe("portada.png");
  });

  test("sin punto queda en negro", () => {
    expect(audienceState(undefined, folder, false, false).black).toBe(false);
    expect(audienceState(undefined, folder, true, false).id).toBe("");
  });
});
