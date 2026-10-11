# Diapositivas guiadas por voz: plan de implementación

> **Para la sesión que lo ejecuta (Sonnet 5.5):** seguí las tareas en orden, una por vez. Cada una dice qué archivos toca, el código, cómo probarla y el commit. El código de este plan **ya se validó** en un worktree aparte (tests, typecheck, `vite build` y `cargo check` en verde), así que si algo no compila, lo más probable es un error al copiar: compará con el plan antes de inventar una solución. Contexto completo: [`docs/plan-presentaciones.md`](../plan-presentaciones.md), sección "Ahora".

**Objetivo:** que Apuntador presente diapositivas e incluso videos en una segunda ventana (proyector), avanzando con la voz como hoy avanza los puntos del guion.

**Arquitectura:** un punto del guion es una diapositiva. El parser suma `diapo:` y `video:` a cada punto; un mazo es una carpeta con `guion.md` y sus archivos, servidos por el protocolo de assets de Tauri. Una segunda `WebviewWindow` (`index.html#audiencia`) muestra lo que le manda la principal por eventos. Con esa ventana abierta, el `Tracker` solo avanza por voz al siguiente (los saltos van a mano) y deja de escuchar mientras suena un video.

**Stack:** Bun, TypeScript strict, React 19, Tailwind v4, Tauri 2.12 (Rust), `bun test`, `cargo test`.

---

## Reglas para esta sesión

- **Bun siempre**: `bun add`, `bun test`, `bun run …`. Nunca npm, npx, yarn ni pnpm.
- Textos de la interfaz y comentarios **en español rioplatense**, como el resto del repo. Sin emojis. Íconos solo de `lucide-react`.
- Leé cada archivo antes de editarlo; los números de línea pueden correrse.
- Un commit por tarea. Cada mensaje termina con:
  ```
  Co-authored-by: Ether <ether@itica.lat>
  ```
  más la línea de atribución que pida tu harness.
- **No** pushear a `main`, **no** crear tags, **no** publicar releases. El trabajo termina en un PR que revisa Faku.
- Si un paso falla dos veces seguidas, pará y anotá el error real en el PR en vez de parchear a ciegas.

### Comandos

| Qué | Comando | Esperado |
|---|---|---|
| Tests TS | `bun test` | todo verde |
| Tipos | `bun run typecheck` | sin salida después de `tsc --noEmit` |
| Build web | `bun run build` | `built in …` y `dist-phone listo` |
| Tests Rust | `cd src-tauri && cargo test --lib` | `test result: ok` |
| App | `bun run tauri dev` | abre Apuntador (la primera compilación tarda minutos) |

---

## Tarea 0: rama

**Objetivo:** trabajar sobre `feat/diapositivas`, que ya trae los dos documentos del plan.

**Paso 1:** desde la raíz del repo (o tu worktree):

```bash
git fetch origin
git switch feat/diapositivas
git log --oneline -3
```

Esperado: el último commit es `docs: plan de presentaciones y plan de diapositivas`. Si tu worktree no puede cambiar a esa rama porque está en uso, usá `git reset --hard feat/diapositivas` sobre tu rama de trabajo (está recién creada, no se pierde nada) y al final pusheá con `git push -u origin HEAD:feat/diapositivas`.

**Paso 2:** confirmar que todo arranca verde:

```bash
bun install
bun test
bun run typecheck
```

---

## Tarea 1: `diapo:` y `video:` en el parser

**Objetivo:** cada punto puede traer la diapositiva y el video que ve el público.

**Archivos:**
- Crear: `src/lib/script.test.ts`
- Modificar: `src/lib/script.ts`

**Paso 1: test que falla.** Crear `src/lib/script.test.ts`:

```ts
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
```

**Paso 2:** `bun test src/lib/script.test.ts` → FALLA (`parseTime` no existe).

**Paso 3: implementación.** En `src/lib/script.ts`:

3a. En el comentario de arriba, después de la línea de `nota:`, sumar:

```
 *   diapo: media/portada.png         (imagen o .html: lo que ve el público)
 *   video: media/demo.mp4 0:12-0:40 auto
```

3b. Reemplazar el tipo `Point` por:

```ts
export type Point = {
  id: string;
  section: number;
  title: string;
  bullets: string[];
  notes: string[];
  keys: string[];
  /** Archivo de la diapositiva, relativo a la carpeta del mazo. */
  slide?: string;
  video?: VideoCue;
};

/** Un video dentro de la presentación; los tiempos en segundos. */
export type VideoCue = { file: string; start?: number; end?: number; auto: boolean };
```

3c. Debajo de `const NOTE = …`, agregar:

```ts
const SLIDE = /^(diapo|slide)\s*:\s*/i;
const VIDEO = /^video\s*:\s*/i;
const SLIDE_FILE = /\.(png|jpe?g|webp|gif|svg|avif|html?)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)$/i;

/** "1:05" son 65 s; "75", 75 s; "1:02:03", 3723 s. null si no es un tiempo. */
export function parseTime(s: string): number | null {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** `media/demo.mp4 0:12-0:40 auto`. null si no nombra un video: entonces la línea es una viñeta. */
export function parseVideo(spec: string): VideoCue | null {
  const tokens = spec.trim().split(/\s+/);
  let auto = false;
  let start: number | undefined;
  let end: number | undefined;
  // El nombre puede tener espacios: es lo que queda al sacar del final el rango y `auto`.
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (/^auto$/i.test(last)) {
      auto = true;
      tokens.pop();
      continue;
    }
    const m = /^([\d:]*)-([\d:]*)$/.exec(last);
    const from = m?.[1] ? parseTime(m[1]) : undefined;
    const to = m?.[2] ? parseTime(m[2]) : undefined;
    if (m && (m[1] || m[2]) && from !== null && to !== null) {
      start = from;
      end = to;
      tokens.pop();
      continue;
    }
    break;
  }
  const file = tokens.join(" ");
  if (!VIDEO_FILE.test(file)) return null;
  const cue: VideoCue = { file, auto };
  if (start !== undefined) cue.start = start;
  if (end !== undefined) cue.end = end;
  return cue;
}

/** `diapo:` o `video:` que nombran un archivo que se puede mostrar. Si no, la línea es una viñeta. */
function mediaOf(line: string): Pick<Point, "slide" | "video"> | null {
  if (SLIDE.test(line)) {
    const slide = line.replace(SLIDE, "").trim();
    return SLIDE_FILE.test(slide) ? { slide } : null;
  }
  if (VIDEO.test(line)) {
    const video = parseVideo(line.replace(VIDEO, ""));
    return video ? { video } : null;
  }
  return null;
}
```

3d. En el `for` de `parseScript`, justo después de `if (!line) continue;`:

```ts
    const media = mediaOf(line);
```

y entre la rama de `NOTE` y el `else` final:

```ts
    } else if (media) {
      Object.assign(ensurePoint(), media);
```

**Paso 4:** `bun test` → todo verde (los tests de `match.test.ts` también parsean guiones).

**Paso 5:**

```bash
git add src/lib/script.ts src/lib/script.test.ts
git commit -m "Guion: diapo: y video: por punto"
```

---

## Tarea 2: modo presentación y pausa en el `Tracker`

**Objetivo:** con el público mirando, por voz solo se pasa al siguiente; mientras suena un video no se escucha.

**Archivos:**
- Modificar: `src/lib/match.ts`, `src/lib/match.test.ts`

**Paso 1: tests que fallan.** En `src/lib/match.test.ts`, cambiar el import de `./match` por:

```ts
import { DEFAULT_TRACKER, Tracker, stem, words } from "./match";
```

y agregar al final del archivo (usa la constante `SCRIPT` que ya está arriba):

```ts
describe("Tracker presentando", () => {
  const doc = parseScript(SCRIPT);
  const presenting = { ...DEFAULT_TRACKER, onlyNext: true };

  test("con onlyNext no se saltea puntos por voz", () => {
    const t = new Tracker(doc, presenting);
    t.final("filtros de rubro", 1_000);
    t.final("el mercado: sueldos medios, cuánto es el salario por puesto", 6_000);
    expect(t.final("los sueldos del mercado, el salario medio de cada puesto", 9_000).index).toBe(0);
  });

  test("con onlyNext el siguiente pasa igual", () => {
    const t = new Tracker(doc, presenting);
    t.final("los filtros por rubro y departamento", 1_000);
    expect(t.final("y si es tu primer empleo marcás sin experiencia", 5_000).index).toBe(1);
  });

  test("con onlyNext una opinión de afuera tampoco salta", () => {
    const t = new Tracker(doc, presenting);
    expect(t.propose(2, 5_000).index).toBe(0);
    expect(t.propose(2, 6_000).index).toBe(0);
  });

  test("held ignora lo que entra mientras suena un video", () => {
    const t = new Tracker(doc);
    t.held = true;
    expect(t.final("tenés filtros por rubro y por departamento", 1_000).covered.size).toBe(0);
    expect(t.partial("filtros por rubro y departamento", 1_500).covered.size).toBe(0);
    t.held = false;
    expect(t.final("tenés filtros por rubro y por departamento", 2_000).covered.has(0)).toBe(true);
  });
});
```

El primero es el mismo caso que el test existente "saltearse un punto pide dos frases que coincidan", que sin `onlyNext` sí llega al punto 2.

**Paso 2:** `bun test src/lib/match.test.ts` → FALLAN los nuevos.

**Paso 3: implementación** en `src/lib/match.ts`:

3a. En `TrackerOptions`, después de `minDwellMs: number;`:

```ts
  /** Presentando: por voz solo se pasa al siguiente; los saltos van a mano. */
  onlyNext?: boolean;
```

3b. En la clase, después de `covered = new Set<number>();`:

```ts
  /** Mientras suena un video, lo que entra por el micrófono no es el presentador. */
  held = false;
```

3c. Primera línea de `final(...)` y de `partial(...)`:

```ts
    if (this.held) return this.snapshot();
```

3d. En `evaluate`, reemplazar `const near = REACH.map(([offset, reach]) => {` por:

```ts
    const only = this.options.onlyNext === true;
    const near = REACH.filter(([offset]) => !only || offset === 1).map(([offset, reach]) => {
```

y `const far = this.idx` por `const far = only ? [] : this.idx` (el resto de la cadena `.map(...).filter(...)` queda igual).

3e. En `propose`, reemplazar la primera línea del cuerpo por:

```ts
    if (this.held || !this.options.auto || offset === 0 || offset < -1 || offset > 3) return this.snapshot();
    if (this.options.onlyNext && offset !== 1) return this.snapshot();
```

**Paso 4:** `bun test` → verde.

**Paso 5:**

```bash
git add src/lib/match.ts src/lib/match.test.ts
git commit -m "Seguimiento: modo presentación (solo el siguiente) y pausa durante videos"
```

---

## Tarea 3: `deck.ts`, el mazo y lo que ve el público

**Objetivo:** funciones puras para resolver archivos del mazo y armar el estado de la ventana del público.

**Archivos:**
- Crear: `src/lib/deck.ts`, `src/lib/deck.test.ts`

**Paso 1: test que falla.** Crear `src/lib/deck.test.ts`:

```ts
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
```

**Paso 2:** `bun test src/lib/deck.test.ts` → FALLA (no existe `./deck`).

**Paso 3:** crear `src/lib/deck.ts`:

```ts
/**
 * El mazo: la carpeta de una presentación (`guion.md` + archivos) y lo que se
 * le manda a la ventana del público. Sin nada de Tauri: se prueba solo.
 */

import type { Point } from "./script";

export type MediaKind = "imagen" | "html" | "video";

/** Qué es un archivo por su extensión. null si no se puede mostrar. */
export function mediaKind(file: string): MediaKind | null {
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file)) return "imagen";
  if (/\.html?$/i.test(file)) return "html";
  if (/\.(mp4|webm|mov|m4v)$/i.test(file)) return "video";
  return null;
}

/**
 * La ruta completa de un archivo del mazo, con barras de Windows. Una ruta
 * absoluta queda como está. null sin carpeta o si sale de ella con `..`.
 */
export function resolveMedia(folder: string | undefined, file: string): string | null {
  const f = file.trim().replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(f) || f.startsWith("\\\\")) return f;
  if (!folder) return null;
  const rel = f.replace(/^\.\\/, "");
  if (rel.split("\\").includes("..")) return null;
  return `${folder.replace(/[\\/]+$/, "")}\\${rel}`;
}

/** Si el video llegó al final de su rango. */
export function pastEnd(currentTime: number, end: number | undefined): boolean {
  return end !== undefined && currentTime >= end;
}

/** Lo que ve el público, tal cual viaja en el evento `audiencia:estado`. */
export type AudienceState = {
  /** Id del punto: cambia la diapositiva y reinicia el video. */
  id: string;
  title: string;
  bullets: string[];
  slide: { path: string; kind: "imagen" | "html" } | null;
  video: { path: string; start?: number; end?: number } | null;
  /** El archivo que se pidió y no se puede mostrar (para avisar en la diapositiva simple). */
  missing: string | null;
  black: boolean;
  playing: boolean;
};

export const EMPTY_AUDIENCE: AudienceState = {
  id: "",
  title: "",
  bullets: [],
  slide: null,
  video: null,
  missing: null,
  black: true,
  playing: false,
};

export function audienceState(point: Point | undefined, folder: string | undefined, black: boolean, playing: boolean): AudienceState {
  if (!point) return { ...EMPTY_AUDIENCE, black };
  const state: AudienceState = { ...EMPTY_AUDIENCE, id: point.id, title: point.title, bullets: point.bullets, black, playing };
  if (point.video) {
    const path = resolveMedia(folder, point.video.file);
    if (!path) return { ...state, missing: point.video.file };
    const video: AudienceState["video"] = { path };
    if (point.video.start !== undefined) video.start = point.video.start;
    if (point.video.end !== undefined) video.end = point.video.end;
    return { ...state, video };
  }
  if (point.slide) {
    const path = resolveMedia(folder, point.slide);
    const kind = mediaKind(point.slide);
    if (!path || (kind !== "imagen" && kind !== "html")) return { ...state, missing: point.slide };
    return { ...state, slide: { path, kind } };
  }
  return state;
}
```

**Paso 4:** `bun test` → verde.

**Paso 5:**

```bash
git add src/lib/deck.ts src/lib/deck.test.ts
git commit -m "Mazo: rutas de los archivos y estado de la ventana del público"
```

---

## Tarea 4: la carpeta del guion en la biblioteca

**Objetivo:** un guion guardado puede recordar la carpeta de su mazo.

**Archivos:**
- Modificar: `src/lib/library.ts`, `src/lib/library.test.ts`

**Paso 1: test que falla.** En `src/lib/library.test.ts`, antes del `});` final del `describe`:

```ts
  test("un guion puede tener carpeta", () => {
    const l = add(lib(), "Charla", "# Charla", 1, "C:\\Charlas\\wegraph");
    expect(activeScript(l).folder).toBe("C:\\Charlas\\wegraph");
    expect(update(l, l.active, { folder: "D:\\otra" }, 2).scripts.at(-1)?.folder).toBe("D:\\otra");
    expect(activeScript(add(lib(), "Sin", "# Sin", 1)).folder).toBeUndefined();
  });
```

**Paso 2:** `bun test src/lib/library.test.ts` → FALLA (error de tipos o `folder` undefined).

**Paso 3:** en `src/lib/library.ts`:

3a. Reemplazar `StoredScript` por:

```ts
export type StoredScript = {
  id: string;
  name: string;
  text: string;
  updated: number;
  /** Carpeta del mazo: de ahí salen las diapositivas y los videos. */
  folder?: string;
};
```

3b. En `update`, el tipo del parche pasa a `Partial<Pick<StoredScript, "name" | "text" | "folder">>`.

3c. Reemplazar las dos primeras líneas de `add` por:

```ts
export function add(lib: Library, name: string, text: string, now: number, folder?: string): Library {
  const s: StoredScript = { id: newId(), name, text, updated: now };
  if (folder) s.folder = folder;
```

**Paso 4:** `bun test` y `bun run typecheck` → verdes.

**Paso 5:**

```bash
git add src/lib/library.ts src/lib/library.test.ts
git commit -m "Biblioteca: cada guion puede tener la carpeta de su mazo"
```

---

## Tarea 5: dependencias y permisos de Tauri

**Objetivo:** protocolo de assets para los archivos del mazo, diálogo para elegir la carpeta, videos que arrancan solos y permisos para la segunda ventana.

**Archivos:**
- Modificar: `package.json`, `bun.lock`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`

**Paso 1:** dependencias:

```bash
bun add @tauri-apps/plugin-dialog@^2
```

En `src-tauri/Cargo.toml`:
- `tauri = { version = "2", features = [] }` → `tauri = { version = "2", features = ["protocol-asset"] }`
- debajo de `tauri-plugin-process = "2"`, agregar `tauri-plugin-dialog = "2"`

**Paso 2:** en `src-tauri/tauri.conf.json`:
- al final de `additionalBrowserArgs` de la ventana, agregar ` --autoplay-policy=no-user-gesture-required` (con el espacio adelante). Sin esto, WebView2 no deja arrancar un video con sonido en la ventana del público, que nunca recibe un clic.
- `"security": { "csp": null }` pasa a:

```json
    "security": {
      "csp": null,
      "assetProtocol": {
        "enable": true,
        "scope": []
      }
    }
```

El scope arranca vacío a propósito: cada carpeta se habilita en tiempo de ejecución (tarea 6).

**Paso 3:** en `src-tauri/capabilities/default.json`: `"windows": ["main", "audiencia"]` y sumar `"dialog:allow-open"` a `permissions`.

**Paso 4:** en `src-tauri/src/lib.rs`, en `run()`, después de `.plugin(tauri_plugin_process::init())`:

```rust
        .plugin(tauri_plugin_dialog::init())
```

**Paso 5:** `cd src-tauri && cargo check` → compila (baja el plugin y recompila Tauri: un par de minutos). Si `tauri-build` se queja de que `assetProtocol` y la feature `protocol-asset` no coinciden, revisá el paso 1.

**Paso 6:**

```bash
git add package.json bun.lock src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "Tauri: protocolo de assets, diálogo de carpeta y autoplay para la ventana del público"
```

---

## Tarea 6: `deck.rs`, abrir la carpeta del mazo

**Objetivo:** un comando que habilita la carpeta en el protocolo de assets y devuelve su `guion.md`.

**Archivos:**
- Crear: `src-tauri/src/deck.rs`
- Modificar: `src-tauri/src/lib.rs`

**Paso 1: test que falla.** Crear `src-tauri/src/deck.rs` solo con el test:

```rust
//! El mazo de una presentación: una carpeta con `guion.md` y los archivos que
//! muestra la ventana del público.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_guion_de_la_carpeta() {
        let dir = std::env::temp_dir().join(format!("apuntador-mazo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_script(&dir).unwrap(), None);
        std::fs::write(dir.join("guion.md"), "# Hola").unwrap();
        assert_eq!(read_script(&dir).unwrap().as_deref(), Some("# Hola"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
```

y en `lib.rs`, junto a los otros `mod`: `mod deck;`

**Paso 2:** `cd src-tauri && cargo test --lib deck` → no compila (`read_script` no existe).

**Paso 3:** arriba del bloque de tests en `deck.rs`:

```rust
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Lee `guion.md` de la carpeta. `None` si no hay.
pub fn read_script(dir: &Path) -> Result<Option<String>, String> {
    let file = dir.join("guion.md");
    if !file.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&file)
        .map(Some)
        .map_err(|e| format!("No pude leer {}: {e}", file.display()))
}

/// Habilita la carpeta para el protocolo de assets (de ahí se cargan las
/// diapositivas y los videos) y devuelve su guion. El permiso no se guarda:
/// la interfaz lo vuelve a pedir al abrir la app.
#[tauri::command]
pub fn deck_open(app: AppHandle, folder: String) -> Result<Option<String>, String> {
    let dir = PathBuf::from(&folder);
    if !dir.is_dir() {
        return Err(format!("No existe la carpeta {folder}"));
    }
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("No pude abrir la carpeta: {e}"))?;
    read_script(&dir)
}
```

En `lib.rs`, al final de `generate_handler![...]`: `share_stop,` y abajo `deck::deck_open`.

**Paso 4:** `cd src-tauri && cargo test --lib deck` → `test result: ok. 1 passed`.

**Paso 5:**

```bash
git add src-tauri/src/deck.rs src-tauri/src/lib.rs
git commit -m "Mazo: comando para abrir la carpeta y habilitar sus archivos"
```

---

## Tarea 7: `audience.rs`, la ventana del público

**Objetivo:** abrir y cerrar la segunda ventana en el otro monitor, y avisar a la principal si la cierran a mano.

**Archivos:**
- Crear: `src-tauri/src/audience.rs`
- Modificar: `src-tauri/src/lib.rs`

**Paso 1:** crear `src-tauri/src/audience.rs`:

```rust
//! La ventana del público: lo que se ve en el proyector o la segunda pantalla.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "audiencia";

/// Abre la ventana del público a pantalla completa en otro monitor. Con un solo
/// monitor, en una ventana común, para ensayar. Es async: en Windows, crear una
/// ventana desde un comando síncrono traba la app.
#[tauri::command]
pub async fn audience_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return w.show().map_err(|e| e.to_string());
    }
    let main = app.get_webview_window("main").ok_or("No encuentro la ventana principal")?;
    let here = main.current_monitor().ok().flatten();
    let other = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| here.as_ref().is_none_or(|h| m.position() != h.position()));
    // Los mismos argumentos que la principal: WebView2 no abre dos ventanas
    // con entornos distintos.
    let args = app
        .config()
        .app
        .windows
        .first()
        .and_then(|w| w.additional_browser_args.clone())
        .unwrap_or_default();
    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#audiencia".into()))
        .title("Apuntador · Público")
        .focused(false)
        .additional_browser_args(&args);
    let builder = match &other {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            builder.position(p.x as f64 / scale, p.y as f64 / scale).inner_size(1280.0, 720.0)
        }
        None => builder.inner_size(960.0, 540.0),
    };
    let window = builder.build().map_err(|e| format!("No pude abrir la ventana del público: {e}"))?;
    if other.is_some() {
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn audience_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) => w.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
```

**Paso 2:** en `lib.rs`:
- `mod audience;` junto a los otros `mod`.
- en `generate_handler!`, después de `deck::deck_open,`: `audience::audience_open,` y `audience::audience_close`.
- al principio del cierre de `.run(|app, event| {`, antes del `if let tauri::RunEvent::Exit`:

```rust
            // Si se cierra la ventana del público (Alt+F4), la principal sale del modo presentación.
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                if label == audience::LABEL {
                    let _ = tauri::Emitter::emit_to(app, "main", "audiencia:cerrada", ());
                }
            }
```

**Paso 3:** `cd src-tauri && cargo check` → sin errores ni warnings nuevos. `cargo test --lib` → verde.

**Paso 4:**

```bash
git add src-tauri/src/audience.rs src-tauri/src/lib.rs
git commit -m "Ventana del público: abrir en el otro monitor y avisar al cerrarla"
```

---

## Tarea 8: componente `Slide`

**Objetivo:** dibujar lo que ve el público: imagen, HTML aislado, video o el punto en grande.

**Archivos:**
- Crear: `src/components/Slide.tsx`

**Paso 1:** crear el archivo:

```tsx
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { pastEnd, type AudienceState } from "../lib/deck";

type Props = {
  state: AudienceState;
  /** El video llegó al final de su rango o del archivo. */
  onVideoEnd?: () => void;
};

/** Lo que ve el público: la diapositiva, el video o el punto en grande. */
export function Slide({ state, onVideoEnd }: Props) {
  if (state.black) return <div className="h-full w-full bg-black" />;
  if (state.video) return <SlideVideo video={state.video} playing={state.playing} onEnd={onVideoEnd} />;
  if (state.slide?.kind === "imagen")
    return <img src={convertFileSrc(state.slide.path)} alt={state.title} className="h-full w-full object-contain" />;
  if (state.slide?.kind === "html")
    // Sin allow-same-origin: corre su JS pero no toca la app.
    return <iframe title={state.title} src={convertFileSrc(state.slide.path)} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />;
  return (
    <div className="flex h-full w-full flex-col justify-center gap-[4vh] px-[8vw]">
      <h1 className="title m-0">{state.title}</h1>
      {state.bullets.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-[2vh] p-0">
          {state.bullets.map((b, i) => (
            <li key={i} className="bullet flex items-start gap-[0.6em]">
              <span aria-hidden className="mt-[0.5em] size-[0.35em] shrink-0 rounded-full bg-current" />
              <span className="min-w-0">{b}</span>
            </li>
          ))}
        </ul>
      )}
      {state.missing && <p className="note m-0 font-mono opacity-60">No encuentro {state.missing}</p>}
    </div>
  );
}

function SlideVideo({ video, playing, onEnd }: { video: NonNullable<AudienceState["video"]>; playing: boolean; onEnd?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) v.play().catch(() => onEnd?.());
    else v.pause();
  }, [playing, onEnd]);
  // `#t=` arranca en el inicio del rango sin esperar a que cargue.
  const src = convertFileSrc(video.path) + (video.start ? `#t=${video.start}` : "");
  return (
    <video
      ref={ref}
      src={src}
      className="h-full w-full bg-black object-contain"
      onTimeUpdate={(e) => {
        if (pastEnd(e.currentTarget.currentTime, video.end)) {
          e.currentTarget.pause();
          onEnd?.();
        }
      }}
      onEnded={() => onEnd?.()}
    />
  );
}
```

`.title`, `.bullet` y `.note` son clases de `src/index.css`; el color lo hereda del contenedor.

**Paso 2:** `bun run typecheck` → verde.

**Paso 3:**

```bash
git add src/components/Slide.tsx
git commit -m "Diapositiva: imagen, HTML aislado, video con rango o el punto en grande"
```

---

## Tarea 9: la página del público

**Objetivo:** la misma app, abierta con `#audiencia`, muestra solo la diapositiva y devuelve teclas y el fin del video.

**Archivos:**
- Crear: `src/Audience.tsx`
- Modificar: `src/main.tsx`

**Paso 1:** crear `src/Audience.tsx`:

```tsx
import { emitTo, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Slide } from "./components/Slide";
import { EMPTY_AUDIENCE, type AudienceState } from "./lib/deck";

/**
 * La ventana del público. Muestra lo que manda la principal y le devuelve el
 * fin del video y las teclas: si alguien toca esta ventana, el clicker sigue
 * mandando en la principal.
 */
export function Audience() {
  const [state, setState] = useState<AudienceState>(EMPTY_AUDIENCE);

  useEffect(() => {
    document.body.style.background = "#000";
    // Primero escuchar, después pedir el estado: si no, la respuesta llega antes.
    const off = listen<AudienceState>("audiencia:estado", (e) => setState(e.payload));
    void off.then(() => emitTo("main", "audiencia:lista"));
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      void emitTo("main", "audiencia:tecla", e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onVideoEnd = useCallback(() => void emitTo("main", "audiencia:video-fin"), []);

  return (
    <main className="h-full w-full cursor-none bg-black text-white">
      <Slide key={state.id} state={state} onVideoEnd={onVideoEnd} />
    </main>
  );
}
```

**Paso 2:** reemplazar `src/main.tsx` entero:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Audience } from "./Audience";
import "./index.css";

// La misma página sirve a las dos ventanas; la del público se abre con #audiencia.
const audience = window.location.hash === "#audiencia";

createRoot(document.getElementById("root")!).render(<StrictMode>{audience ? <Audience /> : <App />}</StrictMode>);
```

**Paso 3:** `bun run typecheck` → verde.

**Paso 4:**

```bash
git add src/Audience.tsx src/main.tsx
git commit -m "Ventana del público: la página que muestra la diapositiva"
```

---

## Tarea 10: conectar la ventana del público en `App.tsx`

**Objetivo:** P abre la ventana, la principal le manda cada punto, el video pausa el seguimiento, B pone negro y se ve una miniatura.

**Archivos:**
- Modificar: `src/App.tsx`

Son varios bloques; hacelos en este orden y corré `bun run typecheck` al final.

**10a. Imports.** Después de `import { invoke } from "@tauri-apps/api/core";`:

```ts
import { emitTo, listen } from "@tauri-apps/api/event";
```

Antes de `import { Progress, Stage } from "./components/Stage";`:

```ts
import { Slide } from "./components/Slide";
```

y después de esa misma línea:

```ts
import { audienceState } from "./lib/deck";
```

**10b. Estado.** Después de `const clock = useRef({ since: 0, acc: 0 });`:

```ts

  // Presentando: la ventana del público abierta, en negro o con el video sonando.
  const [audience, setAudience] = useState(false);
  const [black, setBlack] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [presentProblem, setPresentProblem] = useState<string | null>(null);
```

**10c. Tracker.** Reemplazar la línea `const trackerOptions = { … minDwellMs: 2_500 };` por:

```ts
  // Con el público mirando, un salto equivocado se ve: por voz solo el siguiente.
  const trackerOptions = { sensitivity: settings.sensitivity, auto: settings.auto, windowMs: 12_000, minDwellMs: 2_500, onlyNext: audience };
```

y después de `const index = Math.min(snap.index, …);`:

```ts
  const point = doc.points[index];
  const folder = activeScript(library).folder;
  // Mientras suena el video el micrófono levanta su audio: no sirve para seguir.
  tracker.current.held = audience && playing && !!point?.video;
```

**10d. Efectos.** Después de `useEffect(() => saveLibrary(library), [library]);`:

```ts

  // El permiso de la carpeta del mazo no se guarda: se pide de nuevo al abrir.
  useEffect(() => {
    if (inTauri() && folder) void invoke("deck_open", { folder }).catch(() => {});
  }, [folder]);

  // Cada punto con video arranca solo si dice `auto`.
  useEffect(() => setPlaying(!!point?.video?.auto), [point]);

  const shown = useMemo(() => audienceState(point, folder, black, playing), [point, folder, black, playing]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (audience) void emitTo("audiencia", "audiencia:estado", shown);
  }, [audience, shown]);

  useEffect(() => {
    if (!inTauri()) return;
    const offs = [
      listen("audiencia:lista", () => void emitTo("audiencia", "audiencia:estado", shownRef.current)),
      listen<string>("audiencia:tecla", (e) => window.dispatchEvent(new KeyboardEvent("keydown", { key: e.payload }))),
      listen("audiencia:video-fin", () => setPlaying(false)),
      listen("audiencia:cerrada", () => {
        setAudience(false);
        setBlack(false);
      }),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, []);

  const toggleAudience = useCallback(async () => {
    setPresentProblem(null);
    if (!inTauri()) {
      setPresentProblem("La ventana del público necesita la app instalada");
      return;
    }
    try {
      await invoke(audience ? "audience_close" : "audience_open");
      setAudience(!audience);
      setBlack(false);
    } catch (e) {
      setPresentProblem(e instanceof Error ? e.message : String(e));
    }
  }, [audience]);
```

**10e. Teclas.** En el objeto `actions` del `onKey`:
- reemplazar `" ": () => jump(index + 1),` por:

```ts
        // Con video en pantalla, Espacio lo pausa y lo sigue.
        " ": () => (audience && point?.video ? setPlaying((v) => !v) : jump(index + 1)),
```

- antes de `Escape: () => setPanel(null),`:

```ts
        p: () => void toggleAudience(),
        b: () => {
          if (audience) setBlack((v) => !v);
        },
```

- en el array de dependencias de ese `useEffect`, sumar al final `audience, point, toggleAudience`.

**10f. Estado abajo.** En el `<footer>`, antes de `{speech.state === "listening" && level.silent && (`:

```tsx
            {audience && (
              <span title="La ventana del público está abierta: por voz solo se pasa al siguiente">
                {black ? "Público en negro" : playing && point?.video ? "Público · video" : "Presentando"}
              </span>
            )}
            {presentProblem && (
              <span className="rounded-full border border-[var(--color-signal)] px-2 py-0.5 text-[var(--color-signal)]" role="alert">
                {presentProblem}
              </span>
            )}
```

**10g. Miniatura (T7 del plan, prioridad P1).** Justo antes de `{settings.camera && (` / `<CameraPreview`:

```tsx
      {audience && !lightOnly && (
        <div
          aria-label="Lo que ve el público"
          className={`pointer-events-none absolute bottom-12 ${settings.cameraCorner.endsWith("izq") ? "right-5" : "left-5"} aspect-video w-[18vw] overflow-hidden rounded-md border border-[var(--edge)] bg-black text-white [--scale:0.22]`}
        >
          {shown.video ? (
            <p className="m-0 grid h-full place-items-center font-mono text-xs">{playing ? "Video sonando" : "Video en pausa"}</p>
          ) : (
            <Slide key={shown.id} state={shown} />
          )}
        </div>
      )}
```

Va en la esquina opuesta a la cámara. Con video muestra el estado en texto, no un segundo video (dos decodificaciones y el audio duplicado).

**Paso final:** `bun run typecheck`, `bun test`, `bun run build` → verdes.

```bash
git add src/App.tsx
git commit -m "Presentar: P abre la ventana del público, B la pone en negro, el video pausa el seguimiento"
```

---

## Tarea 11: "Abrir carpeta" en el editor

**Objetivo:** sumar un guion desde una carpeta con `guion.md`, recordando la carpeta para los archivos.

**Archivos:**
- Modificar: `src/components/Editor.tsx`

**Paso 1: imports.** Reemplazar las dos primeras líneas por:

```ts
import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Copy, FilePlus, FileUp, FolderOpen, RotateCcw, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
```

y después de `import { parseScript } from "../lib/script";`:

```ts
import { inTauri } from "../lib/speech";
```

(`open` ya es el nombre de la función que abre un .md; por eso el alias `pickFolder`.)

**Paso 2: estado.** Después de `const [copied, setCopied] = useState(false);`:

```ts
  const [folderError, setFolderError] = useState<string | null>(null);
```

**Paso 3: función.** Antes de `const save = () => onSave(committed());`:

```ts
  /** Una carpeta con guion.md y sus archivos: suma un guion que muestra diapositivas y videos. */
  const openFolder = async () => {
    setFolderError(null);
    try {
      const folder = await pickFolder({ directory: true, title: "Carpeta de la presentación" });
      if (typeof folder !== "string") return;
      const text = await invoke<string | null>("deck_open", { folder });
      if (text === null) {
        setFolderError("En esa carpeta no hay guion.md");
        return;
      }
      const lib = committed();
      const base = folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
      load(add(lib, uniqueName(lib, base || nameOf(text)), text, Date.now(), folder));
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    }
  };
```

Ojo con la regex `/[\\/]/`: tiene que cortar por `\` y por `/` (las rutas de Windows vienen con `\`).

**Paso 4: botón.** Después del botón "Abrir .md" (el que cierra con `</button>` tras `<FileUp …/> Abrir .md`):

```tsx
          {inTauri() && (
            <button type="button" onClick={() => void openFolder()} className={btn}>
              <FolderOpen className="size-4" /> Abrir carpeta
            </button>
          )}
          {folderError && (
            <span className="text-[var(--color-signal)]" role="alert">
              {folderError}
            </span>
          )}
          {current.folder && !folderError && (
            <span className="max-w-[18rem] truncate font-mono text-xs text-[var(--muted)]" title={current.folder}>
              {current.folder}
            </span>
          )}
```

**Paso 5: ayuda del formato.** En el `<pre>` del panel "Formato", el texto termina en `nota: recordatorio"}`; reemplazarlo por `nota: recordatorio\ndiapo: media/portada.png\nvideo: media/demo.mp4 0:12-0:40 auto"}` (con `\n` literales, como el resto de ese string). Y después del `<li>` de las notas:

```tsx
            <li><strong className="text-[var(--ink)]">diapo</strong> y <strong className="text-[var(--ink)]">video</strong> son lo que ve el público (P). Los archivos salen de la carpeta del guion: "Abrir carpeta" con un guion.md adentro.</li>
            <li>El video arranca solo con <code>auto</code>; el rango (0:12-0:40) es opcional.</li>
```

**Paso 6:** `bun run typecheck` → verde.

```bash
git add src/components/Editor.tsx
git commit -m "Editor: abrir una carpeta con guion.md como mazo"
```

El texto del guion se guarda en la app como siempre: editarlo en Apuntador **no** reescribe `guion.md`. La carpeta es la fuente de los archivos. Dejalo dicho en el README (tarea 13).

---

## Tarea 12: atajos en la ayuda

**Archivos:**
- Modificar: `src/components/Panels.tsx` (constante `SHORTCUTS`)

**Paso 1:**
- `["→  Espacio  Av Pág", "Punto siguiente"],` → `["→  Espacio  Av Pág", "Punto siguiente (con video en pantalla, Espacio lo pausa)"],`
- después de `["G", "Grabar / terminar la toma"],`:

```ts
  ["P", "Ventana del público (proyector)"],
  ["B", "Público en negro"],
```

**Paso 2:**

```bash
git add src/components/Panels.tsx
git commit -m "Ayuda: atajos P y B"
```

---

## Tarea 13: README

**Archivos:**
- Modificar: `README.md`

**Paso 1:** tabla **Estructura**, sumar filas:

| Carpeta | Qué hace |
|---|---|
| `src/lib/deck.ts` | El mazo: rutas de sus archivos y lo que ve el público. |
| `src/components/Slide.tsx` | La diapositiva: imagen, HTML aislado, video o el punto en grande. |
| `src/Audience.tsx` | La página de la ventana del público (`#audiencia`). |
| `src-tauri/src/deck.rs` | Abre la carpeta del mazo y habilita sus archivos. |
| `src-tauri/src/audience.rs` | Abre la ventana del público en el otro monitor. |

**Paso 2:** sección nueva **## Presentar**, después de **## Cómo decide**. Contenido, en el tono del resto del README:

- El formato: `diapo:` (imagen o `.html`) y `video:` (`archivo [inicio-fin] [auto]`), con el ejemplo de la tarea 1. Un punto sin `diapo:` muestra su título y viñetas. Una línea `diapo:`/`video:` que no nombra un archivo válido sigue siendo viñeta.
- **Mazo = carpeta** con `guion.md` y los archivos (por ejemplo en `media/`): Editor (E) → **Abrir carpeta**. Las rutas son relativas a la carpeta. Editar el guion en la app no reescribe `guion.md`.
- **P** abre la ventana del público: a pantalla completa en el otro monitor; con uno solo, en una ventana para ensayar. Cerrarla (P o Alt+F4) vuelve al modo normal. Si se hace clic en ella, las teclas y el clicker siguen mandando en la principal.
- **Modo presentación**: con la ventana abierta, por voz solo se pasa al siguiente; los saltos van con flechas, clicker o el índice (O). Abajo dice "Presentando".
- **Video**: con `auto` arranca al entrar al punto; Espacio lo pausa y lo sigue; al terminar (o al llegar al fin del rango) vuelve a escuchar. Mientras suena, lo que entra por el micrófono no cuenta (es el audio del video). Formatos: MP4 (H.264), WebM, MOV.
- **B** pone negro al público. La miniatura abajo muestra lo que está viendo.
- Las diapositivas `.html` corren aisladas (`sandbox`): su JavaScript anda, pero no toca la app.

**Paso 3:** tabla **Atajos**: sumar `| P | Ventana del público |` y `| B | Público en negro |`, y en la primera fila aclarar que con video en pantalla Espacio pausa.

**Paso 4:**

```bash
git add README.md
git commit -m "README: presentar con diapositivas y video"
```

---

## Tarea 14: verificación completa

**Paso 1:** todo verde:

```bash
bun test
bun run typecheck
bun run build
cd src-tauri && cargo test --lib
```

**Paso 2: mazo de prueba** fuera del repo (no commitear archivos de video):

```
%TEMP%\mazo-prueba\
  guion.md
  media\portada.png     (cualquier imagen)
  media\demo.mp4        (cualquier MP4 de 20-60 s con sonido)
```

`guion.md`:

```
# Prueba
## Portada
claves: portada, bienvenida
diapo: media/portada.png
- Hola a todos

## Demo
claves: demo, video
video: media/demo.mp4 0:02-0:10 auto

## Cierre
claves: cierre, gracias
- Gracias
```

**Paso 3: humo en la app** (`bun run tauri dev`, con un solo monitor alcanza):

1. E → **Abrir carpeta** → `%TEMP%\mazo-prueba`. Aparece el guion "mazo-prueba" con la ruta abajo. Guardar.
2. **P** → se abre "Apuntador · Público" en una ventana de 960x540 con la portada. Abajo dice "Presentando" y se ve la miniatura.
3. → (flecha): pasa a Demo; el video arranca solo en el segundo 2 y se detiene en el 10. La miniatura dice "Video sonando" y después "Video en pausa".
4. Espacio con el video en pantalla: pausa y sigue.
5. **B**: la ventana del público queda negra; B de nuevo, vuelve.
6. Clic en la ventana del público y →: avanza igual (la tecla se reenvía).
7. Cerrar la ventana del público con la X: abajo deja de decir "Presentando".
8. En la consola de la ventana principal (F12): `__decir("hablemos del cierre y gracias")` desde Portada **con** la ventana abierta → **no** salta dos puntos.

Anotá en el PR qué pasos se probaron y cuáles no. Lo que no se puede probar acá (segundo monitor real, proyector, parlantes) va como checklist para Faku.

**Paso 4: revisión de diseño.** Correr el agente `wefaber-house:design-conformance-reviewer` sobre el diff y corregir lo que marque como bloqueante.

---

## Tarea 15: versión y PR

**Paso 1:** subir la versión a `0.3.0` en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json` (las tres tienen que coincidir; `release.yml` falla si el tag no coincide con `tauri.conf.json`). Correr `cd src-tauri && cargo check` para que se actualice `Cargo.lock`.

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Versión 0.3.0"
```

**Paso 2:** push y PR contra `main`:

```bash
git push -u origin HEAD:feat/diapositivas
gh pr create --base main --head feat/diapositivas --title "Presentar: diapositivas y video guiados por voz"
```

El cuerpo del PR (usá la skill `pr` si está disponible), en español:
- qué hace, en dos o tres líneas;
- cómo se verificó: salida real de los comandos de la tarea 14 y los pasos de humo que se hicieron;
- **checklist para Faku** (lo que necesita hardware): segundo monitor o proyector a pantalla completa; video con los parlantes de la sala sin que el seguimiento salte; clicker contra la ventana del público; un ensayo entero con el mazo real;
- después del merge, el release es de Faku: `git tag v0.3.0 && git push origin v0.3.0`.

**No** mergear, **no** taggear.

---

## Riesgos conocidos

| Riesgo | Qué mirar |
|---|---|
| Pantalla completa en el monitor equivocado | Tarea 7 posiciona la ventana en el otro monitor y recién después llama `set_fullscreen`. Si en el proyector queda en el principal, anotarlo en el PR con el modelo de monitores. |
| El video no arranca solo | Revisar que `--autoplay-policy=no-user-gesture-required` esté en `additionalBrowserArgs` (tarea 5). Si `play()` falla, `SlideVideo` lo trata como fin y el seguimiento vuelve a escuchar. |
| "WebView2 environment with different options" al abrir P | Los argumentos de la ventana del público salen de `tauri.conf.json`; no hardcodearlos en Rust. |
| Un `.mkv` no se ve | No está soportado a propósito: WebView2 no lo reproduce bien. Pasarlo a MP4 sin recomprimir: `ffmpeg -i toma.mkv -c copy toma.mp4`. |
| Archivos del mazo que no cargan tras reiniciar | El scope del protocolo de assets se vuelve a pedir en el efecto de la tarea 10d, que ignora los errores. Si la carpeta se movió o se borró, la diapositiva muestra "No encuentro …" o queda en blanco: volver a abrir la carpeta desde el editor. |
