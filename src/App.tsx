import { getCurrentWindow } from "@tauri-apps/api/window";
import { Camera, CircleDot, Headphones, CircleHelp, FolderOpen, Lightbulb, Square, X, ListTree, Maximize, Mic, MicOff, NotebookText, PenLine, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CameraPreview, previewWidth, useMediaDevices } from "./components/Camera";
import { PhoneWaiting, usePhone } from "./components/Phone";
import type { Facing, PhoneScript } from "./lib/phone-protocol";
import { Editor } from "./components/Editor";
import { HintPill, Notes } from "./components/Coaching";
import { Drawer, Help, Outline, ScriptPicker, SettingsPanel } from "./components/Panels";
import { Progress, Stage } from "./components/Stage";
import type { Prosody } from "./lib/coach";
import DEFAULT_SCRIPT from "./lib/default-script.md?raw";
import type { Transport } from "./lib/llm";
import { Tracker, type Snapshot } from "./lib/match";
import { openMic, phoneTakeBase, Recording, type Saved } from "./lib/recorder";
import { parseScript, type Doc } from "./lib/script";
import { PHONE_CAMERA, loadSettings, saveSettings, surface, type Settings } from "./lib/settings";
import { activeScript, loadLibrary, saveLibrary, type Library } from "./lib/library";
import {
  createRecognizer,
  downloadModel,
  inTauri,
  listInputs,
  llmAvailable,
  modelInfo,
  tauriTransport,
  type ModelInfo,
  type ModelProgress,
  type Recognizer,
  type SpeechState,
} from "./lib/speech";
import { useCoaching } from "./useCoaching";
import { useVoiceCoach } from "./useVoiceCoach";
import { keytermsOf, type EngineConfig, type EngineMode } from "./lib/engine";

type Panel = null | "outline" | "settings" | "help" | "editor" | "notes";

/** En el dev server de Vite, un proxy local a DeepSeek (ver vite.config.ts). */
const devTransport: Transport = async (system, user, maxTokens) => {
  const r = await fetch("/__dev/llm", { method: "POST", body: JSON.stringify({ system, user, maxTokens }) });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
};

const ENGINE_LABEL = { parakeet: "Parakeet v3", navegador: "Reconocimiento del navegador", ninguno: "Ninguno" } as const;
const MODE_LABEL: Record<EngineMode, string> = { auto: "Parakeet v3, automático", local: "Parakeet v3, local", remota: "Parakeet v3, otra PC", xai: "xAI" };

export function App() {
  const [library, setLibrary] = useState<Library>(() => loadLibrary(DEFAULT_SCRIPT));
  const script = activeScript(library).text;
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const doc = useMemo(() => parseScript(script), [script]);

  const tracker = useRef<Tracker>(null as unknown as Tracker);
  const trackedDoc = useRef<Doc | null>(null);
  const [snap, setSnap] = useState<Snapshot>({ index: 0, covered: new Set() });

  const [panel, setPanel] = useState<Panel>(null);
  const [lightOnly, setLightOnly] = useState(false);
  const [controls, setControls] = useState(true);

  const [speech, setSpeech] = useState<{ state: SpeechState; message?: string }>({ state: "idle" });
  const [level, setLevel] = useState({ level: 0, speaking: false, silent: false });
  const [heard, setHeard] = useState({ final: "", partial: "" });
  const [engineLabel, setEngineLabel] = useState<{ label: string; note: string | null } | null>(null);
  const [sttProblem, setSttProblem] = useState<string | null>(null);

  const [model, setModel] = useState<ModelInfo | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);

  const [elapsed, setElapsed] = useState(0);
  const clock = useRef({ since: 0, acc: 0 });

  // El tracker se rehace con cada guion nuevo, conservando el punto.
  const trackerOptions = { sensitivity: settings.sensitivity, auto: settings.auto, windowMs: 12_000, minDwellMs: 2_500 };
  if (trackedDoc.current !== doc) {
    const prev = tracker.current?.index ?? 0;
    const t = new Tracker(doc, trackerOptions);
    t.jump(Math.min(prev, Math.max(doc.points.length - 1, 0)), Date.now());
    tracker.current = t;
    trackedDoc.current = doc;
  }
  tracker.current.options = trackerOptions;

  const index = Math.min(snap.index, Math.max(doc.points.length - 1, 0));

  const [send, setSend] = useState<Transport | null>(null);
  const [llmOk, setLlmOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (inTauri()) {
      void llmAvailable().then((ok) => {
        setLlmOk(ok);
        if (ok) setSend(() => tauriTransport);
      });
    } else if (import.meta.env.DEV) {
      void fetch("/__dev/llm").then((r) => {
        setLlmOk(r.ok);
        if (r.ok) setSend(() => devTransport);
      });
    } else setLlmOk(false);
  }, []);

  const coaching = useCoaching({ doc, script, settings, tracker, setSnap, index, send });
  // La voz dice lo mismo que se muestra, aunque el texto esté oculto (solo luz).
  const spoken = coaching.hint && (coaching.hint.kind === "camara" || settings.coach) ? coaching.hint : null;
  const voice = useVoiceCoach({ settings, hint: spoken, speaking: level.speaking });
  const [cameraOpened, setCameraOpened] = useState(0);
  const [cameraMode, setCameraMode] = useState<string | null>(null);
  const devices = useMediaDevices(cameraOpened);
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");

  // El iPhone como cámara, por la red.
  const isPhone = settings.camera && settings.cameraDevice === PHONE_CAMERA;
  const phone = usePhone(isPhone, settings.phoneRoute);
  // El teléfono dice qué cámara tiene; la PC solo le pide un cambio cuando lo
  // elegís acá. Así no se pisan.
  const facingFromPhone = useRef<Facing | null>(null);
  useEffect(() => {
    const f = phone.state.facing;
    if (!f) return;
    facingFromPhone.current = f;
    setSettings((s) => (s.phoneFacing === f ? s : { ...s, phoneFacing: f }));
  }, [phone.state.facing]);
  useEffect(() => {
    if (phone.state.phone && settings.phoneFacing !== facingFromPhone.current) phone.link.current?.setFacing(settings.phoneFacing);
  }, [settings.phoneFacing, phone.state.phone, phone.link]);
  // El punto actual va al teléfono: con la frontal se lee ahí, al lado del lente.
  useEffect(() => {
    if (!phone.state.phone) return;
    const p = doc.points[index];
    const n = doc.points[index + 1];
    const script: PhoneScript | null = p
      ? {
          section: doc.sections[p.section]?.title ?? "",
          title: p.title,
          bullets: p.bullets,
          covered: [...snap.covered],
          next: n?.title ?? null,
          nextBullets: n?.bullets ?? [],
          nextSection: n && n.section !== p.section ? (doc.sections[n.section]?.title ?? null) : null,
          index,
          total: doc.points.length,
        }
      : null;
    phone.link.current?.sendScript(script);
  }, [phone.state.phone, phone.link, doc, index, snap.covered]);

  // Grabación: el video de la vista previa y el micrófono, a un archivo en la PC.
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const recording = useRef<Recording | null>(null);
  const [recState, setRecState] = useState<{ on: boolean; busy: boolean }>({ on: false, busy: false });
  const [saved, setSaved] = useState<(Saved & { error?: string }) | null>(null);
  // La toma del iPhone, a calidad completa, en paralelo con la de la PC.
  const phoneTake = useRef<{ id: string; started: Promise<unknown> } | null>(null);
  const [phoneSaved, setPhoneSaved] = useState<(Saved & { error?: string }) | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  // El tiempo de la toma y la luz, al teléfono. El reloj se manda cada vez que
  // cambia (medio segundo mientras corre); el teléfono cuenta entre medio.
  useEffect(() => {
    if (!phone.state.phone) return;
    const rec = recState.on && recording.current ? Date.now() - recording.current.started : null;
    phone.link.current?.sendClock(elapsed, speech.state === "listening", rec);
  }, [phone.state.phone, phone.link, elapsed, speech.state, recState.on]);
  useEffect(() => {
    if (phone.state.phone) phone.link.current?.sendLight(settings.light);
  }, [phone.state.phone, phone.link, settings.light]);

  const phoneLink = phone.link;
  const startPhoneTake = useCallback(
    (at: Date) => {
      const link = phoneLink.current;
      if (!link) return;
      const id = crypto.randomUUID().replaceAll("-", "");
      const started = invoke("phone_take_begin", { take: id, base: phoneTakeBase(at) })
        .then(() => link.startTake(id, settings.recordMbps * 1_000_000))
        .then(({ warning }) => warning && setRecError(warning));
      started.catch((e: unknown) => setRecError(`El iPhone no graba (queda la vista previa): ${e instanceof Error ? e.message : String(e)}`));
      phoneTake.current = { id, started };
    },
    [phoneLink, settings.recordMbps],
  );

  /** Termina la del iPhone y espera a que llegue entera. null si nunca arrancó. */
  const finishPhoneTake = useCallback(
    async (take: { id: string; started: Promise<unknown> }): Promise<(Saved & { error?: string }) | null> => {
      const ok = await take.started.then(
        () => true,
        () => false,
      );
      let problem: string | null = null;
      if (ok) {
        try {
          const link = phoneLink.current;
          if (!link) throw new Error("Se cerró la cámara del iPhone");
          problem = (await link.stopTake(take.id)).error;
        } catch (e) {
          problem = `${e instanceof Error ? e.message : String(e)}: se guardó lo que llegó`;
        }
      }
      try {
        const s = await invoke<Saved>("phone_take_end", { take: take.id });
        return problem ? { ...s, error: problem } : s;
      } catch (e) {
        return ok ? { path: "", bytes: 0, error: problem ?? (e instanceof Error ? e.message : String(e)) } : null;
      }
    },
    [phoneLink],
  );

  const stopRecording = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    const take = phoneTake.current;
    phoneTake.current = null;
    setRecState({ on: false, busy: true });
    const pc = rec.stop().then(
      (s): Saved & { error?: string } => s,
      (e: unknown) => ({ path: rec.path, bytes: 0, error: e instanceof Error ? e.message : String(e) }),
    );
    const [pcSaved, fromPhone] = await Promise.all([pc, take ? finishPhoneTake(take) : null]);
    rec.stopMic();
    setSaved(pcSaved);
    setPhoneSaved(fromPhone);
    setRecState({ on: false, busy: false });
  }, [finishPhoneTake]);

  const startRecording = useCallback(async () => {
    setRecError(null);
    setSaved(null);
    setPhoneSaved(null);
    if (!settings.camera) {
      setSettings((s) => ({ ...s, camera: true }));
      setRecError("Prendí la cámara. Cuando se vea, apretá grabar otra vez.");
      return;
    }
    if (!cameraStream) {
      setRecError("La cámara todavía no manda imagen.");
      return;
    }
    setRecState({ on: false, busy: true });
    let mic: MediaStream | null = null;
    try {
      mic = await openMic(settings.recordMic);
      // Con el permiso dado, la lista ya trae los nombres de los micrófonos.
      setCameraOpened((n) => n + 1);
      const at = new Date();
      const rec = await Recording.start({
        video: cameraStream,
        audio: mic,
        container: settings.recordContainer,
        bitrate: settings.recordMbps * 1_000_000,
        tauri: inTauri(),
        onError: setRecError,
        date: at,
      });
      recording.current = rec;
      setRecState({ on: true, busy: false });
      if (isPhone && settings.phoneRecord && inTauri()) startPhoneTake(at);
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      setRecError(e instanceof Error ? e.message : String(e));
      setRecState({ on: false, busy: false });
    }
  }, [settings.camera, settings.recordMic, settings.recordContainer, settings.recordMbps, settings.phoneRecord, cameraStream, isPhone, startPhoneTake]);

  const toggleRecord = useCallback(() => {
    if (recState.busy) return;
    void (recording.current ? stopRecording() : startRecording());
  }, [recState.busy, startRecording, stopRecording]);

  // Si la cámara se cierra o cambia a mitad de la toma, se guarda lo grabado.
  useEffect(() => {
    if (!cameraStream && recording.current) void stopRecording();
  }, [cameraStream, stopRecording]);
  const onFinalRef = useRef(coaching.onFinal);
  onFinalRef.current = coaching.onFinal;

  const recognizer = useRef<Recognizer | null>(null);
  useEffect(() => {
    const onFinal = (text: string, prosody: Prosody | null) => {
      setHeard((h) => ({ final: (h.final + " " + text).trim().slice(-240), partial: "" }));
      setSnap(tracker.current.final(text, Date.now()));
      onFinalRef.current(text, prosody);
    };
    const r = createRecognizer({
      onPartial: (text) => {
        setHeard((h) => ({ ...h, partial: text }));
        setSnap(tracker.current.partial(text, Date.now()));
      },
      onFinal,
      onState: (state, message) => setSpeech({ state, message }),
      onLevel: (l, speaking, silent) => setLevel({ level: l, speaking, silent }),
      onEngine: (label, note) => setEngineLabel({ label, note }),
      onProblem: (message) => setSttProblem(message),
    });
    recognizer.current = r;
    // En desarrollo, `__decir("texto")` en la consola hace de micrófono.
    // Con un segundo argumento simula también cómo se dijo (ver coach.ts).
    if (import.meta.env.DEV)
      (window as unknown as { __decir: (t: string, p?: Prosody) => void }).__decir = (t, p) => onFinal(t, p ?? null);
    return () => r.dispose();
  }, []);

  useEffect(() => {
    void modelInfo().then(setModel);
    void listInputs().then(setInputs);
  }, []);

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveLibrary(library), [library]);

  // Reloj: corre mientras escucha.
  useEffect(() => {
    if (speech.state !== "listening") {
      if (clock.current.since) {
        clock.current.acc += Date.now() - clock.current.since;
        clock.current.since = 0;
      }
      return;
    }
    clock.current.since = Date.now();
    const id = setInterval(() => setElapsed(clock.current.acc + Date.now() - clock.current.since), 500);
    return () => clearInterval(id);
  }, [speech.state]);

  // Que la pantalla no se apague a mitad de la grabación.
  useEffect(() => {
    if (speech.state !== "listening") return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, [speech.state]);

  const jump = useCallback((i: number) => {
    tracker.current.jump(i, Date.now());
    setSnap({ index: tracker.current.index, covered: new Set(tracker.current.covered) });
    setHeard((h) => ({ ...h, partial: "" }));
  }, []);

  // Otro guion es otra toma: arranca del primer punto, con reloj y notas en cero.
  const applyLibrary = (next: Library) => {
    if (next.active !== library.active) {
      jump(0);
      clock.current = { since: speech.state === "listening" ? Date.now() : 0, acc: 0 };
      setElapsed(0);
      coaching.reset();
    }
    setLibrary(next);
  };

  const listening = speech.state === "listening" || speech.state === "loading";

  const toggleMic = useCallback(() => {
    const r = recognizer.current;
    if (!r) return;
    if (listening) {
      void r.stop();
      return;
    }
    // Con otra PC o xAI no hace falta el modelo; en automático decide Rust.
    if (r.engine === "parakeet" && settings.sttMode === "local" && model && !model.present) {
      setPanel("settings");
      setModelError("Primero hay que bajar el modelo.");
      return;
    }
    const engine: EngineConfig = {
      mode: settings.sttMode,
      accel: settings.sttAccel || null,
      remoteUrl: settings.sttRemoteUrl || null,
      remoteKey: settings.sttRemoteKey || null,
      keyterms: keytermsOf(doc),
    };
    setSttProblem(null);
    void r.start(settings.device, engine);
  }, [listening, model, settings.device, settings.sttMode, settings.sttAccel, settings.sttRemoteUrl, settings.sttRemoteKey, doc]);

  // Un error de red se muestra un rato y se va solo.
  useEffect(() => {
    if (!sttProblem) return;
    const id = setTimeout(() => setSttProblem(null), 8_000);
    return () => clearTimeout(id);
  }, [sttProblem]);

  const fullscreen = useCallback(async () => {
    try {
      if (inTauri()) {
        const w = getCurrentWindow();
        await w.setFullscreen(!(await w.isFullscreen()));
      } else if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Sin pantalla completa se sigue igual.
    }
  }, []);

  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);

  const startDownload = useCallback(() => {
    setModelError(null);
    setProgress({ downloaded: 0, total: null, stage: "download" });
    downloadModel(setProgress)
      .then((info) => setModel(info))
      .catch((e: unknown) => setModelError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProgress(null));
  }, []);

  // Controles que se esconden solos, para que la pantalla quede limpia.
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 2_800);
  }, []);
  useEffect(() => {
    wake();
    window.addEventListener("mousemove", wake);
    return () => window.removeEventListener("mousemove", wake);
  }, [wake]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel === "editor") return;
      const t = e.target;
      if (t instanceof HTMLElement && t.closest("input, select, textarea")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));
      const actions: Record<string, () => void> = {
        ArrowRight: () => jump(index + 1),
        " ": () => jump(index + 1),
        PageDown: () => jump(index + 1),
        ArrowLeft: () => jump(index - 1),
        PageUp: () => jump(index - 1),
        Home: () => jump(0),
        m: toggleMic,
        a: () => patch({ auto: !settings.auto }),
        l: () => setLightOnly((v) => !v),
        o: () => toggle("outline"),
        s: () => toggle("settings"),
        "?": () => toggle("help"),
        h: () => toggle("help"),
        e: () => setPanel("editor"),
        n: () => toggle("notes"),
        t: () => patch({ transcript: !settings.transcript }),
        f: () => void fullscreen(),
        c: () => patch({ camera: !settings.camera }),
        g: toggleRecord,
        "+": () => patch({ textScale: Math.min(1.8, +(settings.textScale + 0.05).toFixed(2)) }),
        "=": () => patch({ textScale: Math.min(1.8, +(settings.textScale + 0.05).toFixed(2)) }),
        "-": () => patch({ textScale: Math.max(0.6, +(settings.textScale - 0.05).toFixed(2)) }),
        r: () => {
          clock.current = { since: speech.state === "listening" ? Date.now() : 0, acc: 0 };
          setElapsed(0);
          coaching.reset();
        },
        Escape: () => setPanel(null),
      };
      const act = actions[k.length === 1 ? k.toLowerCase() : k];
      if (act) {
        e.preventDefault();
        act();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, index, jump, toggleMic, patch, settings, fullscreen, speech.state, coaching.reset, toggleRecord]);

  const { bg, ink } = surface(settings.light, settings.brightness);
  const style = { "--bg": bg, "--ink": ink, "--scale": settings.textScale } as CSSProperties;
  const showChrome = controls || panel !== null;
  const recognizerEngine = recognizer.current?.engine ?? (inTauri() ? "parakeet" : "navegador");
  const engineName = recognizerEngine === "parakeet" ? MODE_LABEL[settings.sttMode] : ENGINE_LABEL[recognizerEngine];

  const mm = Math.floor(elapsed / 60_000);
  const ss = Math.floor((elapsed % 60_000) / 1000);

  useEffect(() => {
    document.body.style.background = bg;
  }, [bg]);

  return (
    <main style={style} className={`relative h-full w-full select-none bg-[var(--bg)] text-[var(--ink)] ${showChrome ? "" : "cursor-none"}`}>
      {!lightOnly && <Progress doc={doc} index={index} />}
      {!lightOnly && <Stage
          doc={doc}
          index={index}
          covered={snap.covered}
          settings={settings}
          tones={coaching.tones}
          reserve={settings.camera ? { side: settings.cameraCorner.endsWith("izq") ? "left" : "right", width: previewWidth(settings) } : null}
        />}
      {settings.camera && (
        <CameraPreview
          // Con el iPhone, espejo solo con la frontal: la trasera ya se ve derecha.
          settings={isPhone ? { ...settings, cameraMirror: settings.phoneFacing === "user" } : settings}
          onHint={(h) => coaching.notify({ kind: "camara", text: h.text, say: h.say, t: Date.now() })}
          onOpen={(mode) => {
            setCameraMode(mode);
            setCameraOpened((n) => n + 1);
          }}
          onStream={setCameraStream}
          recording={recState.on}
          phone={isPhone ? { stream: phone.stream, waiting: <PhoneWaiting info={phone.info} error={phone.error} state={phone.state} route={settings.phoneRoute} onRoute={(r) => patch({ phoneRoute: r })} /> } : null}
        />
      )}
      {!lightOnly && coaching.hint && (coaching.hint.kind === "camara" || settings.coach) && (
        <HintPill hint={coaching.hint} onDismiss={coaching.dismissHint} />
      )}

      {/* Barra de arriba */}
      <header
        className={`absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-4 px-5 pt-4 transition-opacity duration-300 ${
          showChrome ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <p className="m-0 font-display text-base font-bold">
          Apuntador <span className="ml-2 font-body text-xs font-normal text-[var(--muted)]">{engineName}</span>
        </p>
        <nav className="flex items-center gap-1 rounded-full border border-[var(--edge)] bg-[var(--panel)] p-1 shadow-[0_8px_30px_-10px_rgb(0_0_0/0.25)]" aria-label="Controles">
          <IconButton label={listening ? "Pausar (M)" : "Escuchar (M)"} onClick={toggleMic} active={listening}>
            {listening ? <Mic className="size-5" /> : <MicOff className="size-5" />}
          </IconButton>
          <IconButton label={recState.on ? "Terminar la toma (G)" : "Grabar (G)"} onClick={toggleRecord} active={recState.on}>
            {recState.on ? <Square className="size-4 fill-current" /> : <CircleDot className="size-5 text-[var(--color-signal)]" />}
          </IconButton>
          <IconButton label="Cámara (C)" onClick={() => patch({ camera: !settings.camera })} active={settings.camera}>
            <Camera className="size-5" />
          </IconButton>
          <IconButton label="Solo luz (L)" onClick={() => setLightOnly((v) => !v)} active={lightOnly}>
            <Lightbulb className="size-5" />
          </IconButton>
          <IconButton label="Índice (O)" onClick={() => setPanel((p) => (p === "outline" ? null : "outline"))} active={panel === "outline"}>
            <ListTree className="size-5" />
          </IconButton>
          <IconButton label="Editar guion (E)" onClick={() => setPanel("editor")}>
            <PenLine className="size-5" />
          </IconButton>
          <IconButton label="Notas de la toma (N)" onClick={() => setPanel((p) => (p === "notes" ? null : "notes"))} active={panel === "notes"}>
            <NotebookText className="size-5" />
          </IconButton>
          <IconButton label="Ajustes (S)" onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))} active={panel === "settings"}>
            <SlidersHorizontal className="size-5" />
          </IconButton>
          <IconButton label="Pantalla completa (F)" onClick={() => void fullscreen()}>
            <Maximize className="size-5" />
          </IconButton>
          <IconButton label="Atajos (?)" onClick={() => setPanel((p) => (p === "help" ? null : "help"))} active={panel === "help"}>
            <CircleHelp className="size-5" />
          </IconButton>
        </nav>
      </header>

      {/* Estado abajo: siempre algo, aunque la barra esté escondida */}
      {!lightOnly && (
        <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 px-5 pb-4 font-mono text-xs text-[var(--muted)]">
          <div className="flex items-center gap-3">
            <span
              className={`inline-block size-2.5 rounded-full ${speech.state === "listening" && level.speaking ? "live" : ""}`}
              style={{
                background:
                  speech.state === "listening" ? "var(--color-signal)" : speech.state === "error" ? "var(--color-note)" : "var(--faint)",
              }}
              aria-hidden
            />
            <span>
              {
                {
                  idle: "Pausado",
                  loading: "Cargando el modelo…",
                  listening: settings.auto ? "Escuchando · avanza solo" : "Escuchando · avance a mano",
                  error: speech.message ?? "Error",
                  unavailable: speech.message ?? "Sin reconocimiento de voz",
                }[speech.state]
              }
            </span>
            {voice.enabled && (
              <span className="flex items-center gap-1" title={`La voz del coach habla por ${voice.output ?? "la salida predeterminada"}`}>
                <Headphones className="size-3.5" aria-hidden />
                voz
              </span>
            )}
            {speech.state === "listening" && engineLabel && (
              <span title={engineLabel.note ?? "Dónde se reconoce la voz"} className={engineLabel.note ? "text-[var(--color-signal)]" : ""}>
                {engineLabel.label}
              </span>
            )}
            {sttProblem && (
              <span className="rounded-full border border-[var(--color-signal)] px-2 py-0.5 text-[var(--color-signal)]" role="alert" title={sttProblem}>
                {sttProblem.length > 60 ? `${sttProblem.slice(0, 60)}…` : sttProblem}
              </span>
            )}
            {speech.state === "listening" && level.silent && (
              <span className="rounded-full border border-[var(--color-signal)] px-2 py-0.5 font-bold text-[var(--color-signal)]" role="alert">
                El micrófono manda silencio: ¿está muteado?
              </span>
            )}
            {speech.state === "listening" && (
              <span className="flex h-3 items-end gap-[2px]" aria-hidden>
                {[0.2, 0.45, 0.7, 1].map((f) => (
                  <span key={f} className="w-[3px] bg-[var(--muted)]" style={{ height: `${Math.min(100, (level.level / 0.12) * 100 * f + 15)}%` }} />
                ))}
              </span>
            )}
            <span className="tabular-nums">
              {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
            </span>
            {recState.on && <RecClock since={recording.current?.started ?? Date.now()} />}
            {phone.state.upload && (recState.busy || phone.state.upload.pending > 2) && (
              <span className="tabular-nums" title="La toma del iPhone llega a la PC mientras grabás">
                iPhone: {phone.state.upload.pending} s por llegar · {(phone.state.upload.sentBytes / 1_048_576).toFixed(0)} MB
              </span>
            )}
            {settings.coach && coaching.live.wpm !== null && <span className="tabular-nums">{coaching.live.wpm} ppm</span>}
            {settings.coach && coaching.live.toneSt !== null && (
              <span className="tabular-nums">
                tono {coaching.live.toneSt >= 0 ? "+" : "−"}
                {Math.abs(coaching.live.toneSt).toFixed(1)} st
              </span>
            )}
          </div>
          {settings.transcript && (heard.final || heard.partial) && (
            <p className="m-0 max-w-[48vw] truncate text-right" dir="auto">
              {heard.final.split(" ").slice(-10).join(" ")} <span className="opacity-60">{heard.partial}</span>
            </p>
          )}
        </footer>
      )}

      {lightOnly && showChrome && (
        <p className="absolute inset-x-0 bottom-6 m-0 text-center font-mono text-xs text-[var(--muted)]">Solo luz · L para volver al texto</p>
      )}

      {(saved || phoneSaved || recError) && (
        <div
          className="island absolute bottom-12 left-5 z-10 flex max-w-[min(34rem,calc(100%-2.5rem))] items-start gap-3 px-4 py-3 text-sm"
          role="status"
        >
          <div className="min-w-0">
            {recError && <p className="m-0 text-[var(--color-signal)]">{recError}</p>}
            {saved && (
              <>
                <p className="m-0 font-bold">{saved.error ? "Toma guardada con errores" : "Toma guardada"}</p>
                {saved.error && <p className="m-0 text-[var(--color-signal)]">{saved.error}</p>}
                <p className="m-0 break-all font-mono text-xs text-[var(--muted)]">
                  {saved.path}
                  {saved.bytes > 0 && ` · ${(saved.bytes / 1_048_576).toFixed(0)} MB`}
                </p>
              </>
            )}
            {phoneSaved && (
              <>
                <p className="m-0 mt-2 flex items-center gap-2 font-bold">
                  {phoneSaved.path ? (phoneSaved.error ? "iPhone, con errores" : "iPhone, calidad completa") : "El iPhone no guardó la toma"}
                  {phoneSaved.path && (
                    <button
                      type="button"
                      onClick={() => void invoke("rec_reveal", { path: phoneSaved.path }).catch((e: unknown) => setRecError(String(e)))}
                      className="flex items-center gap-1 rounded-md border border-[var(--edge)] px-2 py-0.5 text-xs font-normal hover:bg-[var(--faint)]"
                    >
                      <FolderOpen className="size-3.5" /> Ver
                    </button>
                  )}
                </p>
                {phoneSaved.error && <p className="m-0 text-[var(--color-signal)]">{phoneSaved.error}</p>}
                {phoneSaved.path && (
                  <p className="m-0 break-all font-mono text-xs text-[var(--muted)]">
                    {phoneSaved.path}
                    {phoneSaved.bytes > 0 && ` · ${(phoneSaved.bytes / 1_048_576).toFixed(0)} MB`}
                  </p>
                )}
              </>
            )}
          </div>
          {saved && inTauri() && (
            <button
              type="button"
              onClick={() => void invoke("rec_reveal", { path: saved.path }).catch((e: unknown) => setRecError(String(e)))}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--edge)] px-2.5 py-1 hover:bg-[var(--faint)]"
            >
              <FolderOpen className="size-4" /> Ver
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              setPhoneSaved(null);
              setRecError(null);
            }}
            className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-[var(--faint)]"
            aria-label="Cerrar aviso"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {panel === "outline" && (
        <Drawer title="Índice" onClose={() => setPanel(null)}>
          <ScriptPicker library={library} onSelect={(id) => applyLibrary({ ...library, active: id })} onEdit={() => setPanel("editor")} />
          <Outline doc={doc} index={index} onJump={jump} />
        </Drawer>
      )}
      {panel === "settings" && (
        <Drawer title="Ajustes" onClose={() => setPanel(null)}>
          <SettingsPanel
            settings={settings}
            onChange={patch}
            engine={engineName}
            inputs={inputs}
            model={model}
            progress={progress}
            modelError={modelError}
            onDownload={startDownload}
            llmOk={llmOk}
            llmError={coaching.llmError}
            cameras={cameras}
            mics={mics}
            phone={isPhone ? phone.state : null}
            cameraMode={settings.camera ? cameraMode : null}
            voice={voice}
            listening={speech.state === "listening"}
          />
        </Drawer>
      )}
      {panel === "notes" && (
        <Drawer title="Notas de la toma" onClose={() => setPanel(null)}>
          <Notes notes={coaching.notes} doc={doc} tones={coaching.tones} llm={settings.llm && send !== null} />
        </Drawer>
      )}
      {panel === "help" && (
        <Drawer title="Atajos" onClose={() => setPanel(null)}>
          <Help />
        </Drawer>
      )}
      {panel === "editor" && (
        <Editor
          library={library}
          fallback={DEFAULT_SCRIPT}
          onClose={() => setPanel(null)}
          onSave={(next) => {
            applyLibrary(next);
            setPanel(null);
          }}
        />
      )}
    </main>
  );
}

/** REC y el tiempo de la toma; se actualiza solo, sin rehacer toda la pantalla. */
function RecClock({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="flex items-center gap-1.5 font-bold text-[var(--color-signal)] tabular-nums">
      <span className="live inline-block size-2 rounded-full bg-current" aria-hidden />
      REC {String(Math.floor(s / 60)).padStart(2, "0")}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid size-9 place-items-center rounded-full transition-colors ${active ? "bg-[var(--ink)] text-[var(--bg)]" : "hover:bg-[var(--faint)]"}`}
    >
      {children}
    </button>
  );
}
