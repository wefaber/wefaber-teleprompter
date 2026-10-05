import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { inTauri } from "../lib/speech";

const button = "rounded-md border border-[var(--edge)] px-3 py-1.5 text-sm hover:bg-[var(--faint)] disabled:opacity-40";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "found"; update: Update }
  | { kind: "installing"; downloaded: number; total: number | null }
  | { kind: "error"; text: string };

/** Actualizaciones por internet: busca una versión nueva, la baja y reinicia la app. */
export function Updates() {
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const search = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      setPhase(update ? { kind: "found", update } : { kind: "latest" });
    } catch (e) {
      setPhase({ kind: "error", text: message(e) });
    }
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    void getVersion().then(setVersion).catch(() => {});
    void search();
  }, [search]);

  const install = async (update: Update) => {
    let downloaded = 0;
    let total: number | null = null;
    setPhase({ kind: "installing", downloaded, total });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? null;
        if (ev.event === "Progress") downloaded += ev.data.chunkLength;
        setPhase({ kind: "installing", downloaded, total });
      });
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", text: message(e) });
    }
  };

  if (!inTauri()) return <p className="m-0 text-xs text-[var(--muted)]">Las actualizaciones llegan solo a la app instalada.</p>;

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="m-0">
        Versión <span className="font-mono text-xs">{version ?? "…"}</span>
      </p>
      {phase.kind === "checking" && <p className="m-0 text-xs text-[var(--muted)]">Buscando una versión nueva…</p>}
      {phase.kind === "latest" && <p className="m-0 text-xs text-[var(--muted)]">Tenés la última.</p>}
      {phase.kind === "found" && (
        <>
          <p className="m-0 text-xs">
            Hay una versión nueva: <strong className="font-mono">{phase.update.version}</strong>
          </p>
          <button type="button" className={`${button} self-start`} onClick={() => void install(phase.update)}>
            Actualizar y reiniciar
          </button>
        </>
      )}
      {phase.kind === "installing" && (
        <p className="m-0 font-mono text-xs tabular-nums text-[var(--muted)]">
          Bajando… {Math.round(phase.downloaded / 1_048_576)} MB
          {phase.total ? ` de ${Math.round(phase.total / 1_048_576)} MB` : ""}
        </p>
      )}
      {phase.kind === "error" && <p className="m-0 text-xs text-[var(--color-signal)]">{phase.text}</p>}
      {(phase.kind === "latest" || phase.kind === "error") && (
        <button type="button" className={`${button} self-start`} onClick={() => void search()}>
          Buscar de nuevo
        </button>
      )}
    </div>
  );
}
