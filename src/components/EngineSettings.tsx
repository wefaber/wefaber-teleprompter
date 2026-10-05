import { useEffect, useState } from "react";
import {
  ACCEL_LABEL,
  engineBench,
  engineInfo,
  remoteCheck,
  shareInfo,
  shareStart,
  shareStop,
  speed,
  splitShare,
  type Accel,
  type EngineInfo,
  type EngineMode,
  type ShareInfo,
} from "../lib/engine";
import type { Settings } from "../lib/settings";
import { inTauri } from "../lib/speech";
import { Segmented, Toggle } from "./controls";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  modelPresent: boolean;
  listening: boolean;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = "rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5 font-mono text-xs";
const button = "rounded-md border border-[var(--edge)] px-3 py-1.5 text-sm hover:bg-[var(--faint)] disabled:opacity-40";

/** Dirección y clave de la otra PC, y probar que contesta. */
function RemoteFields({ settings, onChange, optional }: { settings: Settings; onChange: Props["onChange"]; optional: boolean }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);

  // Lo que copia "Copiar" trae dirección y clave: al pegar en cualquiera de los
  // dos campos, cada una va a su lugar.
  const pasteShare = (e: React.ClipboardEvent) => {
    const both = splitShare(e.clipboardData.getData("text"));
    if (!both) return;
    e.preventDefault();
    setResult(null);
    onChange({ sttRemoteUrl: both.url, sttRemoteKey: both.key });
  };

  const test = async () => {
    setResult(null);
    setTesting(true);
    try {
      const h = await remoteCheck(settings.sttRemoteUrl, settings.sttRemoteKey);
      setResult({ text: `Anda: ${h.name}${h.accel ? ` con ${ACCEL_LABEL[h.accel]}` : ""}.`, failed: false });
    } catch (e) {
      setResult({ text: message(e), failed: true });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span>Otra PC {optional && <span className="text-xs text-[var(--muted)]">(opcional)</span>}</span>
      <input
        aria-label="Dirección de la otra PC"
        placeholder="https://pc.tailnet.ts.net:5191"
        value={settings.sttRemoteUrl}
        onPaste={pasteShare}
        onChange={(e) => {
          setResult(null);
          onChange({ sttRemoteUrl: e.target.value.trim() });
        }}
        className={field}
      />
      <input
        aria-label="Clave de la otra PC"
        placeholder="Clave"
        type="password"
        value={settings.sttRemoteKey}
        onPaste={pasteShare}
        onChange={(e) => {
          setResult(null);
          onChange({ sttRemoteKey: e.target.value.trim() });
        }}
        className={field}
      />
      <button type="button" className={`${button} self-start`} disabled={testing || !settings.sttRemoteUrl} onClick={() => void test()}>
        {testing ? "Probando…" : "Probar"}
      </button>
      {result && <p className={`m-0 text-xs${result.failed ? " text-[var(--color-signal)]" : ""}`}>{result.text}</p>}
    </div>
  );
}

/** Dónde se reconoce la voz: esta PC (y con qué), otra de la tailnet o xAI. */
export function EngineSettings({ settings, onChange, modelPresent, listening }: Props) {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [busy, setBusy] = useState<"medir" | "compartir" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    void engineInfo().then(setInfo).catch((e: unknown) => setError(message(e)));
    void shareInfo().then(setShare).catch(() => {});
  }, []);

  if (!inTauri()) return <p className="m-0 text-xs text-[var(--muted)]">En el navegador reconoce el propio navegador.</p>;

  const run = async <T,>(kind: NonNullable<typeof busy>, task: () => Promise<T>, done: (r: T) => void) => {
    setBusy(kind);
    setError(null);
    try {
      done(await task());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const hw = info?.hardware;
  const report = info?.report ?? null;
  const slow = info?.slowRtf ?? 0.5;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--edge)] p-3 text-sm">
      <span>Dónde se reconoce</span>
      <Segmented<EngineMode>
        label="Dónde se reconoce"
        value={settings.sttMode}
        options={[
          { value: "auto", label: "Automático" },
          { value: "local", label: "Esta PC" },
          { value: "remota", label: "Otra PC" },
          { value: "xai", label: "xAI" },
        ]}
        onChange={(v) => onChange({ sttMode: v })}
      />
      <p className="m-0 text-xs text-[var(--muted)]">
        {settings.sttMode === "auto"
          ? "Esta PC si le da la velocidad; si no, la otra PC; si no, xAI."
          : settings.sttMode === "local"
            ? "Todo en esta PC: el audio no sale de acá."
            : settings.sttMode === "remota"
              ? "Cada frase va a otra PC de la tailnet y vuelve el texto. No sale a internet."
              : "Cada frase terminada va a xAI (Grok). Se paga por minuto; sin parciales para no pagar dos veces."}
      </p>

      {hw && (
        <div className="flex flex-col gap-1 rounded-md bg-[var(--faint)] p-2 text-xs">
          <span>
            {hw.cpu || "CPU"} · {hw.threads} hilos · {Math.round(hw.ramGb)} GB
          </span>
          {hw.gpus.length > 0 && <span>GPU: {hw.gpus.join(", ")}</span>}
          {hw.npus.length > 0 && <span>NPU: {hw.npus.join(", ")}</span>}
          {report ? (
            report.trials.map((t) => (
              <span key={t.accel} className={t.accel === report.best ? "font-bold" : "text-[var(--muted)]"}>
                {ACCEL_LABEL[t.accel]}: {speed(t.rtf, slow)}
                {t.accel === report.best && " · el que usa"}
                {t.error && ` (${t.error})`}
              </span>
            ))
          ) : (
            <span className="text-[var(--muted)]">
              {modelPresent ? "Sin medir: se mide solo la primera vez que escuchás." : "Sin el modelo bajado no se puede medir esta PC."}
            </span>
          )}
          {modelPresent && (
            <button
              type="button"
              className={`${button} mt-1 self-start`}
              disabled={busy !== null || listening}
              title={listening ? "Pausá la escucha para medir" : undefined}
              onClick={() =>
                void run("medir", engineBench, (r) => setInfo((i) => (i ? { ...i, report: r } : i)))
              }
            >
              {busy === "medir" ? "Midiendo… (unos segundos por acelerador)" : report ? "Medir de nuevo" : "Medir ahora"}
            </button>
          )}
        </div>
      )}

      {settings.sttMode === "local" && report && report.trials.length > 1 && (
        <label htmlFor="stt-accel" className="flex flex-col gap-1">
          Acelerador
          <select
            id="stt-accel"
            value={settings.sttAccel}
            onChange={(e) => onChange({ sttAccel: e.target.value as Accel | "" })}
            className="rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
          >
            <option value="">El más rápido de la medición</option>
            {report.trials.map((t) => (
              <option key={t.accel} value={t.accel}>
                {ACCEL_LABEL[t.accel]}
              </option>
            ))}
          </select>
        </label>
      )}

      {(settings.sttMode === "remota" || settings.sttMode === "auto") && (
        <RemoteFields settings={settings} onChange={onChange} optional={settings.sttMode === "auto"} />
      )}

      {(settings.sttMode === "xai" || settings.sttMode === "auto") && (
        <p className="m-0 text-xs text-[var(--muted)]">
          xAI: {info?.xai ? "XAI_API_KEY presente." : "falta XAI_API_KEY en el entorno (se lee al abrir la app)."} Usa las claves del guion para no
          errarle a nombres y siglas.
        </p>
      )}

      {modelPresent && share && (
        <div className="flex flex-col gap-2 border-t border-[var(--faint)] pt-3">
          <Toggle
            id="share"
            label="Compartir esta PC"
            hint="Otras PCs de la tailnet usan el reconocimiento de esta. Solo dentro de la tailnet, con clave."
            checked={share.on}
            onChange={(on) => void run("compartir", on ? shareStart : shareStop, setShare)}
          />
          {share.on && (
            <div className="flex flex-col gap-1 text-xs">
              <span>En la otra PC, en Otra PC:</span>
              <code className="break-all rounded bg-[var(--faint)] px-2 py-1">{share.url ?? "Tailscale no da el nombre de esta PC"}</code>
              <span className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-[var(--faint)] px-2 py-1">{share.key}</code>
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`${share.url ?? ""}\n${share.key}`)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                      .catch(() => {});
                  }}
                >
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {error && <p className="m-0 text-xs text-[var(--color-signal)]">{error}</p>}
    </div>
  );
}
