import { CameraOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CameraCoach, analyzeFrame, cropRect, isEmptyFrame, modeOrder, parseMode, ratio, type CameraHint } from "../lib/camera";
import { PHONE_CAMERA, type Settings } from "../lib/settings";

/** Cada cuánto se mira un cuadro para los consejos. */
const ANALYZE_MS = 1_500;
/** Lado largo del cuadro que se analiza: alcanza y no pesa. */
const ANALYZE_PX = 160;
/** Cuánto se espera un cuadro con imagen antes de probar otro tamaño. */
const PROBE_MS = 1_800;
/** El tamaño que anduvo la última vez: se prueba primero. */
const LAST_MODE = "apuntador:camara:modo";

/** Cámaras y micrófonos que ve el sistema. Los nombres aparecen después del primer permiso. */
export function useMediaDevices(refresh: number): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    const list = () =>
      void media
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === "videoinput" || d.kind === "audioinput")))
        .catch(() => {});
    list();
    media.addEventListener("devicechange", list);
    return () => media.removeEventListener("devicechange", list);
  }, [refresh]);
  return devices;
}

/** Ancho de la caja en CSS: lo usa también el texto para no quedar debajo. */
export function previewWidth(s: Settings): string {
  return `min(${s.cameraWidth}vw, calc(78vh * ${ratio(s.cameraFormat)}))`;
}

function describe(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return "Sin permiso para usar la cámara.";
  if (name === "NotFoundError") return "No encuentro esa cámara. Elegí otra en Ajustes → Cámara.";
  if (name === "NotReadableError") return "La cámara está ocupada por otra app.";
  return e instanceof Error ? e.message : "No pude abrir la cámara.";
}

function readLast(): string {
  try {
    return localStorage.getItem(LAST_MODE) ?? "";
  } catch {
    return "";
  }
}

function saveLast(mode: string): void {
  try {
    localStorage.setItem(LAST_MODE, mode);
  } catch {
    // La próxima vez vuelve a probar.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera un cuadro que no sea el verde vacío de una cámara virtual. */
async function hasImage(v: HTMLVideoElement, alive: () => boolean): Promise<boolean> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  const until = performance.now() + PROBE_MS;
  while (performance.now() < until && alive()) {
    await sleep(250);
    if (v.readyState < 2 || !v.videoWidth) continue;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    if (!isEmptyFrame(ctx.getImageData(0, 0, canvas.width, canvas.height))) return true;
  }
  return false;
}

type Props = {
  settings: Settings;
  onHint: (h: CameraHint) => void;
  /** Abrió: con qué tamaño ("1920x1080") o "" si no se pudo saber. */
  onOpen: (mode: string) => void;
  /** El video que se ve, para grabarlo; null al cerrarse. */
  onStream: (stream: MediaStream | null) => void;
  recording: boolean;
  /** Con el iPhone: su video (null hasta que llega) y qué mostrar mientras tanto. */
  phone: { stream: MediaStream | null; waiting: ReactNode } | null;
};

/** La toma como va a quedar: recortada al formato, en una esquina. */
export function CameraPreview({ settings, onHint, onOpen, onStream, recording, phone }: Props) {
  const isPhone = settings.cameraDevice === PHONE_CAMERA;
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Abriendo la cámara…");
  const [label, setLabel] = useState("");
  const [ready, setReady] = useState(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const streamRef = useRef(onStream);
  streamRef.current = onStream;

  // DroidCam dice que da varios tamaños pero manda uno solo, el que tenga el
  // cliente; pedirle otro devuelve cuadros verdes. Se prueba hasta que llega
  // imagen de verdad.
  useEffect(() => {
    if (settings.cameraDevice === PHONE_CAMERA) return;
    let stream: MediaStream | null = null;
    let alive = true;
    const isAlive = () => alive;
    setError(null);
    setReady(false);
    setStatus("Abriendo la cámara…");
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError("Esta vista no tiene acceso a cámaras.");
      return;
    }
    const device = settings.cameraDevice ? { deviceId: { exact: settings.cameraDevice } } : {};

    const attempt = async (constraints: MediaTrackConstraints): Promise<boolean> => {
      const s = await media.getUserMedia({ audio: false, video: constraints });
      const v = video.current;
      if (!alive || !v) {
        s.getTracks().forEach((t) => t.stop());
        return false;
      }
      v.srcObject = s;
      await v.play().catch(() => {});
      if (await hasImage(v, isAlive)) {
        stream = s;
        setLabel(s.getVideoTracks()[0]?.label ?? "");
        return true;
      }
      s.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
      return false;
    };

    const open = async () => {
      const modes = settings.cameraMode ? [settings.cameraMode] : modeOrder([readLast()]);
      for (const mode of modes) {
        const size = parseMode(mode);
        if (!size || !alive) continue;
        setStatus(`Probando ${mode}…`);
        try {
          if (await attempt({ ...device, width: { exact: size.width }, height: { exact: size.height } })) {
            if (!settings.cameraMode) saveLast(mode);
            return mode;
          }
        } catch (e) {
          // Una cámara que no tiene ese tamaño: se prueba el siguiente.
          if (e instanceof DOMException && e.name === "OverconstrainedError") continue;
          throw e;
        }
      }
      // Sin tamaño fijo, lo que la cámara quiera.
      if (!settings.cameraMode && alive && (await attempt({ ...device }))) return "";
      return null;
    };

    open()
      .then((mode) => {
        if (!alive) return;
        if (mode === null) {
          setError(
            settings.cameraMode
              ? `En ${settings.cameraMode} la imagen sale verde. Poné la misma resolución que en el cliente de DroidCam, o Automática.`
              : "La cámara abre pero no manda imagen. Fijate que el teléfono esté conectado en el cliente de DroidCam.",
          );
          return;
        }
        setReady(true);
        openRef.current(mode);
        streamRef.current(stream);
      })
      .catch((e: unknown) => alive && setError(describe(e)));
    return () => {
      alive = false;
      streamRef.current(null);
      stream?.getTracks().forEach((t) => t.stop());
      const v = video.current;
      if (v?.srcObject instanceof MediaStream) v.srcObject.getTracks().forEach((t) => t.stop());
    };
  }, [settings.cameraDevice, settings.cameraMode]);

  // El iPhone: el video llega armado por WebRTC, no hay tamaños que probar.
  const phoneStream = phone?.stream ?? null;
  useEffect(() => {
    if (!isPhone) return;
    const v = video.current;
    if (!v) return;
    setError(null);
    setReady(false);
    setLabel("iPhone");
    if (!phoneStream) {
      v.srcObject = null;
      streamRef.current(null);
      return;
    }
    v.srcObject = phoneStream;
    const shown = () => {
      setReady(true);
      openRef.current("");
      streamRef.current(phoneStream);
    };
    v.addEventListener("loadeddata", shown, { once: true });
    void v.play().catch(() => {});
    return () => v.removeEventListener("loadeddata", shown);
  }, [isPhone, phoneStream]);

  // Consejos: un cuadro chico cada tanto, del recorte que se ve.
  const context = useRef({ brightness: settings.brightness, aspect: settings.cameraFormat, rotate: settings.cameraRotate });
  context.current = { brightness: settings.brightness, aspect: settings.cameraFormat, rotate: settings.cameraRotate };
  const hintRef = useRef(onHint);
  hintRef.current = onHint;
  useEffect(() => {
    if (!settings.cameraAdvice || !ready) return;
    const coach = new CameraCoach();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const id = setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2 || document.hidden || !v.videoWidth) return;
      const { aspect, rotate, brightness } = context.current;
      const crop = cropRect(v.videoWidth, v.videoHeight, aspect, rotate);
      const scale = ANALYZE_PX / Math.max(crop.w, crop.h);
      canvas.width = Math.max(1, Math.round(crop.w * scale));
      canvas.height = Math.max(1, Math.round(crop.h * scale));
      ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hint = coach.push(analyzeFrame(frame), Date.now(), { brightness });
      if (hint) hintRef.current(hint);
    }, ANALYZE_MS);
    return () => clearInterval(id);
  }, [settings.cameraAdvice, ready]);

  const r = ratio(settings.cameraFormat);
  const box: CSSProperties = { width: previewWidth(settings), aspectRatio: String(r) };
  const [v, h] = settings.cameraCorner.split("-") as ["arriba" | "abajo", "der" | "izq"];
  const place: CSSProperties = {
    [v === "arriba" ? "top" : "bottom"]: v === "arriba" ? "4.25rem" : "2.75rem",
    [h === "der" ? "right" : "left"]: "1.25rem",
  };

  const quarter = settings.cameraRotate === 90 || settings.cameraRotate === 270;
  const flip = settings.cameraMirror ? "scaleX(-1) " : "";
  const videoStyle: CSSProperties = quarter
    ? {
        // Rotada, la fuente ocupa el alto de la caja como ancho.
        position: "absolute",
        left: "50%",
        top: "50%",
        width: `${100 / r}%`,
        height: `${100 * r}%`,
        transform: `translate(-50%, -50%) ${flip}rotate(${settings.cameraRotate}deg)`,
      }
    : { width: "100%", height: "100%", transform: `${flip}rotate(${settings.cameraRotate}deg)` };

  return (
    <figure
      className={`absolute z-[5] m-0 overflow-hidden rounded-xl bg-black shadow-[0_12px_40px_rgb(0_0_0/0.25)] ${
        recording ? "ring-4 ring-[var(--color-signal)]" : "ring-1 ring-black/20"
      }`}
      style={{ ...box, ...place }}
      aria-label={label ? `Vista previa: ${label}` : "Vista previa de la cámara"}
    >
      {/* Mientras prueba tamaños no se muestra: serían destellos verdes. */}
      <video
        ref={video}
        muted
        playsInline
        className="block max-w-none object-cover"
        style={{ ...videoStyle, visibility: ready ? "visible" : "hidden" }}
      />

      {settings.cameraGuides && ready && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {[1, 2].map((i) => (
            <div key={`v${i}`} className="absolute inset-y-0 w-px bg-white/35" style={{ left: `${(i * 100) / 3}%` }} />
          ))}
          {[1, 2].map((i) => (
            <div key={`h${i}`} className="absolute inset-x-0 h-px bg-white/35" style={{ top: `${(i * 100) / 3}%` }} />
          ))}
          {settings.cameraFormat === "9:16" && (
            <>
              {/* Lo que tapan el nombre, la descripción y los botones de un reel. */}
              <div className="absolute inset-x-0 top-0 h-[13%] bg-black/35" />
              <div className="absolute inset-x-0 bottom-0 h-[22%] bg-black/35" />
              <div className="absolute right-0 bottom-[22%] h-[30%] w-[14%] bg-black/25" />
            </>
          )}
        </div>
      )}

      {isPhone && !ready && !error && (
        <figcaption className="absolute inset-0 grid place-items-center text-center">{phone?.waiting}</figcaption>
      )}
      {(error || !ready) && !(isPhone && !error) && (
        <figcaption className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/85">
          <span className="flex flex-col items-center gap-2">
            {error && <CameraOff className="size-6" aria-hidden />}
            {error ?? status}
          </span>
        </figcaption>
      )}
    </figure>
  );
}
