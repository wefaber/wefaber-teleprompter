/**
 * Varios guiones guardados y cuál se usa. Vive en el almacenamiento de la
 * interfaz, como los ajustes. El guion suelto de antes pasa a ser el primero.
 */

export type StoredScript = { id: string; name: string; text: string; updated: number };

export type Library = { active: string; scripts: StoredScript[] };

const KEY = "apuntador:guiones";
/** Donde estaba el único guion antes de que hubiera varios. */
const LEGACY_KEY = "apuntador:guion";

export const BLANK_SCRIPT = "# Sección\n## Punto\nclaves: \n- Viñeta\n";

export function newId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** El primer título de sección, o "Sin título". */
export function nameOf(text: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() || "Sin título";
}

function one(text: string, now: number): Library {
  const s = { id: newId(), name: nameOf(text), text, updated: now };
  return { active: s.id, scripts: [s] };
}

function valid(x: unknown): x is Library {
  if (!x || typeof x !== "object") return false;
  const l = x as Library;
  return (
    typeof l.active === "string" &&
    Array.isArray(l.scripts) &&
    l.scripts.length > 0 &&
    l.scripts.every((s) => typeof s?.id === "string" && typeof s.name === "string" && typeof s.text === "string")
  );
}

export function loadLibrary(fallback: string): Library {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const lib: unknown = JSON.parse(raw);
      if (valid(lib)) return lib.scripts.some((s) => s.id === lib.active) ? lib : { ...lib, active: lib.scripts[0]!.id };
    }
    return one(localStorage.getItem(LEGACY_KEY) ?? fallback, Date.now());
  } catch {
    return one(fallback, Date.now());
  }
}

export function saveLibrary(lib: Library): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lib));
  } catch {
    // Sin almacenamiento, los guiones duran lo que dura la sesión.
  }
}

export function activeScript(lib: Library): StoredScript {
  return lib.scripts.find((s) => s.id === lib.active) ?? lib.scripts[0]!;
}

export function update(lib: Library, id: string, patch: Partial<Pick<StoredScript, "name" | "text">>, now: number): Library {
  return {
    ...lib,
    scripts: lib.scripts.map((s) => (s.id === id ? { ...s, ...patch, updated: now } : s)),
  };
}

/** Suma un guion y lo deja elegido. */
export function add(lib: Library, name: string, text: string, now: number): Library {
  const s = { id: newId(), name, text, updated: now };
  return { active: s.id, scripts: [...lib.scripts, s] };
}

/** Borra uno; siempre queda al menos uno. Si era el elegido, pasa al de al lado. */
export function remove(lib: Library, id: string): Library {
  if (lib.scripts.length <= 1) return lib;
  const i = lib.scripts.findIndex((s) => s.id === id);
  if (i < 0) return lib;
  const scripts = lib.scripts.filter((s) => s.id !== id);
  const active = lib.active === id ? scripts[Math.min(i, scripts.length - 1)]!.id : lib.active;
  return { active, scripts };
}

export function select(lib: Library, id: string): Library {
  return lib.scripts.some((s) => s.id === id) ? { ...lib, active: id } : lib;
}

/** El nombre sin repetir: "Lanzamiento", "Lanzamiento (2)"… */
export function uniqueName(lib: Library, name: string): string {
  const taken = new Set(lib.scripts.map((s) => s.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}
