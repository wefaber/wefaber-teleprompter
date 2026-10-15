import { describe, expect, test } from "bun:test";
import { parseScript, parseTime, parseVideo } from "./script";

describe("parseTime", () => {
  test("minutos y segundos, segundos solos y horas", () => {
    expect(parseTime("1:05")).toBe(65);
    expect(parseTime("75")).toBe(75);
    expect(parseTime("1:02:03")).toBe(3723);
  });

  test("lo que no es un tiempo da null", () => {
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("1:2:3:4")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
});

describe("parseVideo", () => {
  test("archivo, rango y auto", () => {
    expect(parseVideo("media/demo.mp4 0:12-0:40 auto")).toEqual({ file: "media/demo.mp4", start: 12, end: 40, auto: true });
  });

  test("solo el archivo", () => {
    expect(parseVideo("demo.webm")).toEqual({ file: "demo.webm", auto: false });
  });

  test("nombre con espacios y rango abierto", () => {
    expect(parseVideo("mi video.mp4 1:00-")).toEqual({ file: "mi video.mp4", start: 60, auto: false });
    expect(parseVideo("demo.mp4 -0:30")).toEqual({ file: "demo.mp4", end: 30, auto: false });
  });

  test("sin un archivo de video da null", () => {
    expect(parseVideo("lo que vimos ayer")).toBeNull();
    expect(parseVideo("toma.mkv")).toBeNull();
  });
});

describe("diapositivas y videos en el guion", () => {
  const SCRIPT = `# Intro
## Portada
claves: hola
diapo: media/portada.png
- Quién soy

## Demo
video: media/demo.mp4 0:12-0:40 auto

## Sin diapo
- Solo texto
`;

  test("cada punto lleva su diapositiva o su video", () => {
    const doc = parseScript(SCRIPT);
    expect(doc.points[0]?.slide).toBe("media/portada.png");
    expect(doc.points[0]?.bullets).toEqual(["Quién soy"]);
    expect(doc.points[1]?.video).toEqual({ file: "media/demo.mp4", start: 12, end: 40, auto: true });
    expect(doc.points[2]?.slide).toBeUndefined();
    expect(doc.points[2]?.video).toBeUndefined();
  });

  test("diapo: o video: sin un archivo que se pueda mostrar siguen siendo viñetas", () => {
    const doc = parseScript("# A\n## B\nVideo: lo que vimos ayer\ndiapo: portada\nslide: intro.html");
    expect(doc.points[0]?.bullets).toEqual(["Video: lo que vimos ayer", "diapo: portada"]);
    expect(doc.points[0]?.slide).toBe("intro.html");
  });
});
