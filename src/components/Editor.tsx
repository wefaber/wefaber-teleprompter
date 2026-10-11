import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Copy, FilePlus, FileUp, FolderOpen, RotateCcw, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BLANK_SCRIPT, activeScript, add, nameOf, remove, select, uniqueName, update, type Library } from "../lib/library";
import { parseScript } from "../lib/script";
import { inTauri } from "../lib/speech";

type Props = {
  library: Library;
  fallback: string;
  /** Guardar: los guiones como quedaron y cuál queda elegido. */
  onSave: (library: Library) => void;
  onClose: () => void;
};

/**
 * Edita la biblioteca entera como un borrador: cambiar de guion, sumar o
 * borrar se aplica recién al guardar. Cerrar sin guardar no toca nada.
 */
export function Editor({ library, fallback, onSave, onClose }: Props) {
  const [work, setWork] = useState(library);
  const current = activeScript(work);
  const [draft, setDraft] = useState(current.text);
  const [name, setName] = useState(current.name);
  const [confirm, setConfirm] = useState<"ejemplo" | "borrar" | null>(null);
  const [copied, setCopied] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const doc = useMemo(() => parseScript(draft), [draft]);

  /** La biblioteca con lo que se está escribiendo ya puesto en su guion. */
  const committed = (): Library => {
    const n = name.trim() || nameOf(draft);
    return current.text === draft && current.name === n ? work : update(work, current.id, { text: draft, name: n }, Date.now());
  };
  const dirty = committed() !== library;

  const load = (lib: Library) => {
    const s = activeScript(lib);
    setWork(lib);
    setDraft(s.text);
    setName(s.name);
    setConfirm(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const open = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((text) => {
      const base = f.name.replace(/\.(md|txt)$/i, "");
      const lib = committed();
      load(add(lib, uniqueName(lib, base || nameOf(text)), text, Date.now()));
    });
  };

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

  const save = () => onSave(committed());

  const btn = "flex items-center gap-1.5 rounded-md px-3 py-1.5 hover:bg-[var(--faint)] disabled:opacity-40";

  return (
    <div className="island absolute inset-4 z-30 flex flex-col overflow-hidden">
      <header className="flex flex-col gap-2 border-b border-[var(--faint)] px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="script-pick" className="sr-only">
            Guion
          </label>
          <select
            id="script-pick"
            value={current.id}
            onChange={(e) => load(select(committed(), e.target.value))}
            className="max-w-[16rem] rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5 font-display font-bold"
          >
            {work.scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === current.id ? name || s.name : s.name}
              </option>
            ))}
          </select>
          <label htmlFor="script-name" className="sr-only">
            Nombre
          </label>
          <input
            id="script-name"
            value={name}
            placeholder={nameOf(draft)}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[var(--edge)] bg-transparent px-2 py-1.5 sm:max-w-[16rem]"
          />
          <button type="button" className={btn} onClick={() => {
            const lib = committed();
            load(add(lib, uniqueName(lib, "Guion nuevo"), BLANK_SCRIPT, Date.now()));
          }}>
            <FilePlus className="size-4" /> Nuevo
          </button>
          <button type="button" className={btn} onClick={() => {
            const lib = committed();
            load(add(lib, uniqueName(lib, `${name.trim() || nameOf(draft)} (copia)`), draft, Date.now()));
          }}>
            <Copy className="size-4" /> Duplicar
          </button>
          {confirm === "borrar" ? (
            <span className="flex items-center gap-1 rounded-md border border-[var(--edge)] px-2 py-1">
              ¿Borrar "{name || current.name}"?
              <button type="button" onClick={() => load(remove(committed(), current.id))} className="rounded px-2 py-0.5 font-bold text-[var(--color-signal)] hover:bg-[var(--faint)]">
                Sí
              </button>
              <button type="button" onClick={() => setConfirm(null)} className="rounded px-2 py-0.5 hover:bg-[var(--faint)]">
                No
              </button>
            </span>
          ) : (
            <button type="button" className={btn} disabled={work.scripts.length <= 1} onClick={() => setConfirm("borrar")} title={work.scripts.length <= 1 ? "Tiene que quedar al menos uno" : undefined}>
              <Trash2 className="size-4" /> Borrar
            </button>
          )}
          <span className="ml-auto font-mono text-xs tabular-nums text-[var(--muted)]">
            {doc.sections.length} secciones · {doc.points.length} puntos
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input ref={file} type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={(e) => open(e.target.files?.[0])} />
          <button type="button" onClick={() => file.current?.click()} className={btn}>
            <FileUp className="size-4" /> Abrir .md
          </button>
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
          <button type="button" onClick={copy} className={btn}>
            <ClipboardCopy className="size-4" /> {copied ? "Copiado" : "Copiar"}
          </button>
          {confirm === "ejemplo" ? (
            <span className="flex items-center gap-1 rounded-md border border-[var(--edge)] px-2 py-1">
              ¿Reemplazar este por el de ejemplo?
              <button
                type="button"
                onClick={() => {
                  setDraft(fallback);
                  setConfirm(null);
                }}
                className="rounded px-2 py-0.5 font-bold hover:bg-[var(--faint)]"
              >
                Sí
              </button>
              <button type="button" onClick={() => setConfirm(null)} className="rounded px-2 py-0.5 hover:bg-[var(--faint)]">
                No
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirm("ejemplo")} className={btn}>
              <RotateCcw className="size-4" /> Ejemplo
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={!dirty}
              onClick={save}
              className="rounded-md bg-[var(--ink)] px-4 py-1.5 font-bold text-[var(--bg)] disabled:opacity-40"
            >
              Guardar
            </button>
            <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full hover:bg-[var(--faint)]" aria-label="Cerrar sin guardar">
              <X className="size-5" />
            </button>
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_20rem]">
        <label htmlFor="script" className="sr-only">
          Texto del guion
        </label>
        <textarea
          id="script"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              save();
            }
          }}
          className="scroll min-h-0 resize-none border-0 bg-transparent p-5 font-mono text-[0.95rem] leading-relaxed outline-none"
        />
        <aside className="scroll hidden border-l border-[var(--faint)] p-5 text-sm md:block">
          <h3 className="eyebrow m-0 mb-3 text-[0.72rem] font-bold text-[var(--muted)]">Formato</h3>
          <pre className="m-0 whitespace-pre-wrap rounded-md bg-[var(--faint)] p-3 font-mono text-xs leading-relaxed">
            {"# Sección\n## Punto\nclaves: mcp, agente, eme ce pe\n- Viñeta\nnota: recordatorio\ndiapo: media/portada.png\nvideo: media/demo.mp4 0:12-0:40 auto"}
          </pre>
          <ul className="mt-4 flex flex-col gap-2 pl-4 text-[var(--muted)]">
            <li>Las <strong className="text-[var(--ink)]">claves</strong> son lo que vas a decir de verdad. Pueden ser frases, separadas por comas.</li>
            <li>Si una sigla se transcribe rara, sumá cómo suena: "eme ce pe".</li>
            <li>El título y las viñetas también cuentan, con menos peso.</li>
            <li>Las notas se ven en naranja y no se usan para seguir.</li>
            <li><strong className="text-[var(--ink)]">diapo</strong> y <strong className="text-[var(--ink)]">video</strong> son lo que ve el público (P). Los archivos salen de la carpeta del guion: "Abrir carpeta" con un guion.md adentro.</li>
            <li>El video arranca solo con <code>auto</code>; el rango (0:12-0:40) es opcional.</li>
            <li>El guion que está elegido al guardar es el que se usa.</li>
            <li>Ctrl+S guarda.</li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
