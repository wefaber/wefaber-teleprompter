import { Download, X } from "lucide-react";
import type { ReactNode } from "react";
import { ASPECTS, CAPTURE_MODES, type Aspect, type Rotation } from "../lib/camera";
import type { Library } from "../lib/library";
import type { LinkState, PhoneRoute } from "../lib/phone-link";
import type { Facing } from "../lib/phone-protocol";
import type { Container } from "../lib/recorder";
import { VOICES, type VoiceMode } from "../lib/voice";
import type { Doc } from "../lib/script";
import { LIGHTS, PHONE_CAMERA, type Corner, type Settings } from "../lib/settings";
import type { ModelInfo, ModelProgress } from "../lib/speech";
import type { Sensitivity } from "../lib/match";

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside
      className="island absolute inset-y-4 right-4 z-20 flex w-[min(26rem,calc(100%-2rem))] flex-col overflow-hidden"
      aria-label={title}
    >
      <header className="flex items-center justify-between border-b border-[var(--faint)] px-5 pt-4 pb-3">
        <h2 className="m-0 font-display text-xl font-bold">{title}</h2>
        <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full hover:bg-[var(--faint)]" aria-label="Cerrar">
          <X className="size-5" />
        </button>
      </header>
      <div className="scroll min-h-0 flex-1 pr-2 pb-8 pl-5">{children}</div>
    </aside>
  );
}

/** Qué guion se usa, arriba del índice. */
export function ScriptPicker({ library, onSelect, onEdit }: { library: Library; onSelect: (id: string) => void; onEdit: () => void }) {
  return (
    <div className="mb-5 flex items-center gap-2">
      <label htmlFor="script-active" className="sr-only">
        Guion
      </label>
      <select
        id="script-active"
        value={library.active}
        onChange={(e) => onSelect(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5 font-display text-sm font-bold"
      >
        {library.scripts.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={onEdit} className="rounded-md border border-[var(--edge)] px-3 py-1.5 text-sm hover:bg-[var(--faint)]">
        Editar
      </button>
    </div>
  );
}

export function Outline({ doc, index, onJump }: { doc: Doc; index: number; onJump: (i: number) => void }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-5 p-0">
      {doc.sections.map((s, si) => (
        <li key={si}>
          <p className="eyebrow m-0 mb-2 text-[0.72rem] text-[var(--muted)]">
            <span className="font-mono">{String(si + 1).padStart(2, "0")}</span> · {s.title}
          </p>
          <ol className="m-0 flex list-none flex-col p-0">
            {doc.points.map((p, pi) =>
              p.section !== si ? null : (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onJump(pi)}
                    aria-current={pi === index ? "step" : undefined}
                    className={`flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-[0.95rem] hover:bg-[var(--faint)] ${
                      pi === index ? "bg-[var(--ink)] text-[var(--bg)] hover:bg-[var(--ink)]" : pi < index ? "text-[var(--muted)]" : ""
                    }`}
                  >
                    <span className="w-6 shrink-0 font-mono text-xs tabular-nums opacity-70">{pi + 1}</span>
                    <span className="min-w-0">{p.title}</span>
                  </button>
                </li>
              ),
            )}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 mt-6 flex flex-col gap-3 border-0 p-0">
      <legend className="eyebrow mb-3 p-0 text-[0.72rem] font-bold text-[var(--muted)]">{label}</legend>
      {children}
    </fieldset>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-[var(--edge)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm ${value === o.value ? "bg-[var(--ink)] text-[var(--bg)]" : "hover:bg-[var(--faint)]"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Range(props: { id: string; label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label htmlFor={props.id} className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between">
        {props.label}
        <span className="font-mono tabular-nums text-[var(--muted)]">
          {props.unit === "x" ? props.value.toFixed(2) + "x" : `${props.value}${props.unit ?? ""}`}
        </span>
      </span>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-[var(--muted)]">{hint}</span>}
      </span>
      <input id={id} type="checkbox" className="mt-1 size-4 accent-[var(--ink)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

type SettingsProps = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  engine: string;
  inputs: string[];
  model: ModelInfo | null;
  progress: ModelProgress | null;
  modelError: string | null;
  onDownload: () => void;
  llmOk: boolean | null;
  llmError: string | null;
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  /** Estado del iPhone, si está elegido como cámara. */
  phone: LinkState | null;
  /** El tamaño con que abrió la cámara, si abrió. */
  cameraMode: string | null;
  voice: { output: string | null; headphones: boolean; enabled: boolean; error: string | null; test: () => void };
};

const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;

export function SettingsPanel({ settings, onChange, engine, inputs, model, progress, modelError, onDownload, llmOk, llmError, cameras, mics, cameraMode, phone, voice }: SettingsProps) {
  const isPhone = settings.cameraDevice === PHONE_CAMERA;
  return (
    <div>
      <Group label="Luz">
        <div className="grid grid-cols-5 gap-2">
          {LIGHTS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => onChange({ light: l.color })}
              aria-pressed={settings.light.toLowerCase() === l.color.toLowerCase()}
              className="flex flex-col items-center gap-1 text-xs"
            >
              <span
                className={`block aspect-square w-full rounded-lg border ${
                  settings.light.toLowerCase() === l.color.toLowerCase() ? "border-[var(--ink)] border-2" : "border-[var(--edge)]"
                }`}
                style={{ background: l.color }}
              />
              {l.label}
              <span className="font-mono text-[0.65rem] text-[var(--muted)]">{l.kelvin}</span>
            </button>
          ))}
        </div>
        <label htmlFor="light-custom" className="flex items-center justify-between text-sm">
          Otro color
          <input
            id="light-custom"
            type="color"
            value={settings.light}
            onChange={(e) => onChange({ light: e.target.value })}
            className="h-8 w-14 cursor-pointer rounded border border-[var(--edge)] bg-transparent"
          />
        </label>
        <Range id="brightness" label="Brillo" value={settings.brightness} min={20} max={100} step={1} unit="%" onChange={(v) => onChange({ brightness: v })} />
      </Group>

      <Group label="Texto">
        <Range id="text-scale" label="Tamaño" value={settings.textScale} min={0.6} max={1.8} step={0.05} unit="x" onChange={(v) => onChange({ textScale: v })} />
        <Range id="text-width" label="Ancho" value={settings.width} min={36} max={92} step={1} unit="%" onChange={(v) => onChange({ width: v })} />
        <Segmented
          label="Posición"
          value={settings.position}
          options={[
            { value: "camara", label: "Bajo la cámara" },
            { value: "arriba", label: "Arriba" },
            { value: "centro", label: "Centro" },
          ]}
          onChange={(v) => onChange({ position: v })}
        />
        {settings.position === "camara" && (
          <>
            <Range id="lens-x" label="Dónde está la cámara" value={settings.lensX} min={0} max={100} step={1} unit="%" onChange={(v) => onChange({ lensX: v })} />
            <p className="m-0 text-xs text-[var(--muted)]">
              Una columna angosta justo debajo del lente: cuanto más cerca lees, menos se nota que no mirás a cámara. La marca de arriba tiene que quedar debajo del teléfono.
            </p>
          </>
        )}
      </Group>

      <Group label="Seguimiento">
        <Toggle
          id="auto"
          label="Avanzar solo"
          hint="Pasa de punto cuando empezás a hablar del siguiente. Apagado, solo tacha viñetas."
          checked={settings.auto}
          onChange={(v) => onChange({ auto: v })}
        />
        <span className="text-sm">Sensibilidad</span>
        <Segmented<Sensitivity>
          label="Sensibilidad"
          value={settings.sensitivity}
          options={[
            { value: "baja", label: "Baja" },
            { value: "media", label: "Media" },
            { value: "alta", label: "Alta" },
          ]}
          onChange={(v) => onChange({ sensitivity: v })}
        />
        <p className="m-0 text-xs text-[var(--muted)]">Baja pide más palabras del punto nuevo antes de saltar. Alta salta con menos.</p>
        <Toggle id="transcript" label="Mostrar lo que escucha" checked={settings.transcript} onChange={(v) => onChange({ transcript: v })} />
      </Group>

      <Group label="Coach">
        <Toggle
          id="coach"
          label="Consejos de voz"
          hint="Ritmo, tono y volumen, medidos en esta PC contra tu propia voz. Solo con Parakeet."
          checked={settings.coach}
          onChange={(v) => onChange({ coach: v })}
        />
        <Toggle
          id="llm"
          label="Análisis con DeepSeek"
          hint="Sigue por el sentido aunque no nombres el punto, sugiere el tono de cada sección y deja una devolución al cerrarla."
          checked={settings.llm}
          onChange={(v) => onChange({ llm: v })}
        />
        <p className="m-0 text-xs text-[var(--muted)]">
          {llmOk === null
            ? "Comprobando DeepSeek…"
            : llmOk
              ? "DeepSeek disponible. Se manda el guion y el texto transcripto, nunca el audio."
              : "DeepSeek no está disponible: falta DEEPSEEK_API_KEY en el entorno."}
        </p>
        {llmError && <p className="m-0 text-xs text-[var(--color-signal)]">{llmError}</p>}
        <span className="text-sm">Voz del coach</span>
        <Segmented<VoiceMode>
          label="Voz del coach"
          value={settings.voiceMode}
          options={[
            { value: "apagada", label: "Apagada" },
            { value: "auriculares", label: "Con auriculares" },
            { value: "siempre", label: "Siempre" },
          ]}
          onChange={(v) => onChange({ voiceMode: v })}
        />
        {settings.voiceMode !== "apagada" && (
          <>
            <label htmlFor="voice" className="flex flex-col gap-1 text-sm">
              Voz
              <span className="flex gap-2">
                <select
                  id="voice"
                  value={settings.voice}
                  onChange={(e) => onChange({ voice: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
                >
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={voice.test} className="rounded-md border border-[var(--edge)] px-3 py-1.5 hover:bg-[var(--faint)]">
                  Probar
                </button>
              </span>
            </label>
            <p className="m-0 text-xs text-[var(--muted)]">
              {settings.voiceMode === "auriculares"
                ? voice.headphones
                  ? `Hablando por ${voice.output}. Dice los consejos en dos o tres palabras, en tus pausas.`
                  : `Callada: la salida es ${voice.output ?? "desconocida"}, no parecen auriculares. Con parlantes el micrófono la grabaría.`
                : "Habla por cualquier salida. Con parlantes, el micrófono y la toma la van a levantar."}
            </p>
            {voice.error && <p className="m-0 text-xs text-[var(--color-signal)]">{voice.error}</p>}
          </>
        )}
      </Group>

      <Group label="Cámara">
        <Toggle
          id="camera"
          label="Vista previa"
          hint="Cómo va quedando la toma, en una esquina. Con DroidCam, elegí DroidCam Source."
          checked={settings.camera}
          onChange={(v) => onChange({ camera: v })}
        />
        {settings.camera && (
          <>
            <label htmlFor="camera-device" className="flex flex-col gap-1 text-sm">
              Cámara
              <select
                id="camera-device"
                value={settings.cameraDevice}
                onChange={(e) => onChange({ cameraDevice: e.target.value })}
                className="rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
              >
                <option value="">La predeterminada</option>
                <option value={PHONE_CAMERA}>iPhone, por la red (QR)</option>
                {cameras.map((c, i) => (
                  <option key={c.deviceId || i} value={c.deviceId}>
                    {c.label || `Cámara ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            {isPhone ? (
              <>
                <span className="text-sm">Cámara del iPhone</span>
                <Segmented<Facing>
                  label="Cámara del iPhone"
                  value={settings.phoneFacing}
                  options={[
                    { value: "environment", label: "Trasera" },
                    { value: "user", label: "Frontal, con guion" },
                  ]}
                  onChange={(v) => onChange({ phoneFacing: v })}
                />
                <p className="m-0 text-xs text-[var(--muted)]">
                  La trasera tiene mejor imagen; el guion queda en el monitor. Con la frontal, el iPhone muestra el punto actual pegado al lente.
                </p>
                <span className="text-sm">Cómo llega el teléfono</span>
                <Segmented<PhoneRoute>
                  label="Cómo llega el teléfono"
                  value={settings.phoneRoute}
                  options={[
                    { value: "temporal", label: "Link temporal" },
                    { value: "tailnet", label: "Tailnet" },
                  ]}
                  onChange={(v) => onChange({ phoneRoute: v })}
                />
                <p className="m-0 text-xs text-[var(--muted)]">
                  {settings.phoneRoute === "temporal"
                    ? "Un link por internet (Tailscale Funnel) que se cierra al cambiar de cámara o cerrar la app. Pasa la página y el armado de la conexión, con token; la imagen va directo por el WiFi."
                    : "Solo dentro de la tailnet: el iPhone necesita Tailscale con su DNS prendido."}
                </p>
                <p className="m-0 font-mono text-xs text-[var(--muted)]">
                  {!phone?.server
                    ? "Servidor apagado"
                    : !phone.phone
                      ? "Sin teléfono: escaneá el QR de la vista previa"
                      : phone.video
                        ? `En vivo · cámara a ${phone.size ?? "?"}`
                        : "Teléfono conectado, sin imagen"}
                </p>
              </>
            ) : (
            <label htmlFor="camera-mode" className="flex flex-col gap-1 text-sm">
              Resolución de captura
              <select
                id="camera-mode"
                value={settings.cameraMode}
                onChange={(e) => onChange({ cameraMode: e.target.value })}
                className="rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
              >
                <option value="">Automática{cameraMode ? ` (${cameraMode})` : ""}</option>
                {CAPTURE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="text-xs text-[var(--muted)]">
                Tiene que coincidir con la del cliente de DroidCam; si no, la imagen sale verde. En Automática prueba hasta que llega imagen.
              </span>
            </label>
            )}
            <span className="text-sm">Formato</span>
            <Segmented<Aspect>
              label="Formato"
              value={settings.cameraFormat}
              options={ASPECTS.map((a) => ({ value: a, label: a }))}
              onChange={(v) => onChange({ cameraFormat: v })}
            />
            <span className="text-sm">Girar</span>
            <Segmented<`${Rotation}`>
              label="Girar"
              value={`${settings.cameraRotate}`}
              options={(["0", "90", "180", "270"] as const).map((r) => ({ value: r, label: `${r}°` }))}
              onChange={(v) => onChange({ cameraRotate: Number(v) as Rotation })}
            />
            <span className="text-sm">Esquina</span>
            <Segmented<Corner>
              label="Esquina"
              value={settings.cameraCorner}
              options={[
                { value: "arriba-izq", label: "↖" },
                { value: "arriba-der", label: "↗" },
                { value: "abajo-izq", label: "↙" },
                { value: "abajo-der", label: "↘" },
              ]}
              onChange={(v) => onChange({ cameraCorner: v })}
            />
            <Range id="camera-width" label="Tamaño" value={settings.cameraWidth} min={14} max={60} step={1} unit="%" onChange={(v) => onChange({ cameraWidth: v })} />
            <Toggle id="camera-mirror" label="Espejo" hint="Como un espejo, más fácil para acomodarte. No cambia lo que se graba." checked={settings.cameraMirror} onChange={(v) => onChange({ cameraMirror: v })} />
            <Toggle id="camera-guides" label="Guías" hint="Tercios y, en 9:16, lo que tapa la interfaz de un reel." checked={settings.cameraGuides} onChange={(v) => onChange({ cameraGuides: v })} />
            <Toggle
              id="camera-advice"
              label="Consejos de cámara"
              hint="Mira la imagen y avisa: falta luz, contraluz, lente sucia, foco, color. Corre en esta PC."
              checked={settings.cameraAdvice}
              onChange={(v) => onChange({ cameraAdvice: v })}
            />
          </>
        )}
      </Group>

      <Group label="Grabación">
        <p className="m-0 text-xs text-[var(--muted)]">
          G graba el video de la vista previa y el micrófono a <span className="font-mono">Videos\Apuntador</span>, cuadro completo, sin el
          recorte ni el espejo.
        </p>
        <label htmlFor="record-mic" className="flex flex-col gap-1 text-sm">
          Micrófono
          <select
            id="record-mic"
            value={settings.recordMic}
            onChange={(e) => onChange({ recordMic: e.target.value })}
            className="rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
          >
            <option value="">El predeterminado</option>
            {mics.map((m, i) => (
              <option key={m.deviceId || i} value={m.deviceId}>
                {m.label || `Micrófono ${i + 1}`}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--muted)]">Se graba tal cual: sin cancelar eco, sin quitar ruido, sin ganancia automática.</span>
        </label>
        <span className="text-sm">Archivo</span>
        <Segmented<Container>
          label="Archivo"
          value={settings.recordContainer}
          options={[
            { value: "mkv", label: "MKV · audio sin compresión" },
            { value: "mp4", label: "MP4 · listo para subir" },
          ]}
          onChange={(v) => onChange({ recordContainer: v })}
        />
        <p className="m-0 text-xs text-[var(--muted)]">
          MKV guarda el audio en PCM y no se pierde si algo se cuelga; para editores que no lo abren, se pasa a MOV sin recomprimir. MP4 va con AAC.
        </p>
        <span className="text-sm">Calidad del video</span>
        <Segmented<"20" | "40" | "80">
          label="Calidad del video"
          value={String(settings.recordMbps) as "20" | "40" | "80"}
          options={[
            { value: "20", label: "20 Mb/s" },
            { value: "40", label: "40 Mb/s" },
            { value: "80", label: "80 Mb/s" },
          ]}
          onChange={(v) => onChange({ recordMbps: Number(v) })}
        />
      </Group>

      <Group label="Voz">
        <p className="m-0 text-sm">
          Motor: <strong>{engine}</strong>
        </p>
        {inputs.length > 0 && (
          <label htmlFor="device" className="flex flex-col gap-1 text-sm">
            Micrófono
            <select
              id="device"
              value={settings.device}
              onChange={(e) => onChange({ device: e.target.value })}
              className="rounded-md border border-[var(--edge)] bg-[var(--bg)] px-2 py-1.5"
            >
              <option value="">El predeterminado de Windows</option>
              {inputs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {model && (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--edge)] p-3 text-sm">
            <p className="m-0">
              Modelo <span className="font-mono text-xs">{model.name}</span>:{" "}
              <strong>{model.present ? "listo" : "sin bajar"}</strong>
            </p>
            <p className="m-0 break-all font-mono text-[0.7rem] text-[var(--muted)]">{model.path}</p>
            {!model.present && !progress && (
              <button
                type="button"
                onClick={onDownload}
                className="flex items-center justify-center gap-2 rounded-md bg-[var(--ink)] px-3 py-2 text-[var(--bg)]"
              >
                <Download className="size-4" /> Bajar el modelo (unos 670 MB)
              </button>
            )}
            {progress && (
              <div className="flex flex-col gap-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--faint)]">
                  <div
                    className="h-full bg-[var(--ink)] transition-[width]"
                    style={{ width: progress.total ? `${(progress.downloaded / progress.total) * 100}%` : "100%" }}
                  />
                </div>
                <span className="font-mono text-xs tabular-nums text-[var(--muted)]">
                  {progress.stage === "extract"
                    ? "Descomprimiendo…"
                    : `${mb(progress.downloaded)}${progress.total ? ` de ${mb(progress.total)}` : ""}`}
                </span>
              </div>
            )}
            {modelError && <p className="m-0 text-xs text-[var(--color-signal)]">{modelError}</p>}
            <p className="m-0 text-xs text-[var(--muted)]">Corre en esta PC. El audio no sale de acá.</p>
          </div>
        )}
      </Group>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["→  Espacio  Av Pág", "Punto siguiente"],
  ["←  Re Pág", "Punto anterior"],
  ["Inicio", "Volver al primero"],
  ["M", "Escuchar / pausar"],
  ["A", "Avanzar solo sí / no"],
  ["L", "Solo luz (esconde el texto)"],
  ["O", "Índice de puntos"],
  ["E", "Editar el guion"],
  ["N", "Notas de la toma"],
  ["S", "Ajustes"],
  ["T", "Mostrar lo que escucha"],
  ["+  −", "Tamaño del texto"],
  ["F", "Pantalla completa"],
  ["C", "Vista previa de la cámara"],
  ["G", "Grabar / terminar la toma"],
  ["R", "Reiniciar reloj, base de voz y notas"],
  ["Esc", "Cerrar paneles"],
];

export function Help() {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {SHORTCUTS.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-xs leading-6 text-[var(--muted)]">{k}</dt>
          <dd className="m-0 leading-6">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
