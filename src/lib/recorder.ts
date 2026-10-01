/**
 * Grabar la toma en la PC: el video de la cámara que está en la vista previa
 * (DroidCam o la que sea) y el audio del micrófono,
 * sin el procesado de voz del navegador. En la app los pedazos van a disco a
 * medida que salen; en el navegador se bajan al terminar.
 */

import { invoke } from "@tauri-apps/api/core";

export type Container = "mkv" | "mp4";

/** Del mejor al peor. MKV con PCM: audio sin comprimir y sobrevive a un corte. */
const FORMATS: Record<Container, string[]> = {
  mkv: ["video/x-matroska;codecs=avc1.640028,pcm", "video/x-matroska;codecs=avc1,pcm", "video/x-matroska;codecs=avc1,opus"],
  mp4: ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1.640028,opus"],
};

const FALLBACK = ["video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"];

export function pickFormat(container: Container, supported: (t: string) => boolean): { mime: string; ext: string } | null {
  for (const mime of [...FORMATS[container], ...FORMATS[container === "mkv" ? "mp4" : "mkv"], ...FALLBACK]) {
    if (!supported(mime)) continue;
    const ext = mime.startsWith("video/x-matroska") ? "mkv" : mime.startsWith("video/mp4") ? "mp4" : "webm";
    return { mime, ext };
  }
  return null;
}

/** Qué hay adentro, en palabras: "H.264 + PCM". */
export function describeFormat(mime: string): string {
  const codecs = /codecs=([^;]+)/.exec(mime)?.[1] ?? "";
  const video = codecs.includes("avc1") || codecs.includes("h264") ? "H.264" : codecs.includes("vp9") ? "VP9" : "video";
  const audio = codecs.includes("pcm") ? "audio PCM sin compresión" : codecs.includes("mp4a") ? "audio AAC" : "audio Opus";
  return `${video} + ${audio}`;
}

/** toma-2026-09-30_12-04-05-iphone: la del iPhone, sin extensión (la pone el teléfono). */
export function phoneTakeBase(date: Date): string {
  return takeName(date, "x").replace(/\.x$/, "-iphone");
}

/** toma-2026-09-30_12-04-05.mkv, en hora local. */
export function takeName(date: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const time = `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  return `toma-${day}_${time}.${ext}`;
}

/** Micrófono tal cual: sin cancelar eco, sin quitar ruido, sin ganancia automática. */
export async function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
    },
  });
}

export type Saved = { path: string; bytes: number };

type Sink = {
  write: (chunk: Blob) => Promise<void>;
  close: () => Promise<Saved>;
};

/**
 * Base64 nativo: rápido y sin armar el texto a mano. Va como texto porque así
 * llega igual por cualquiera de los dos caminos del IPC de Tauri (ver
 * rec_write en lib.rs).
 */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer()) as Uint8Array & { toBase64?: () => string };
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("No pude leer el pedazo de video"));
    reader.readAsDataURL(blob);
  });
}

async function tauriSink(name: string): Promise<{ sink: Sink; path: string }> {
  const path = await invoke<string>("rec_start", { name });
  return {
    path,
    sink: {
      write: async (chunk) => {
        await invoke("rec_write", { data: await toBase64(chunk) });
      },
      close: () => invoke<Saved>("rec_stop"),
    },
  };
}

/** Fuera de la app: todo en memoria y se baja al terminar. */
function browserSink(name: string, mime: string): { sink: Sink; path: string } {
  const parts: Blob[] = [];
  return {
    path: name,
    sink: {
      write: async (chunk) => void parts.push(chunk),
      close: async () => {
        const blob = new Blob(parts, { type: mime.split(";")[0] });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        return { path: name, bytes: blob.size };
      },
    },
  };
}

export type RecordOptions = {
  video: MediaStream;
  audio: MediaStream;
  container: Container;
  /** Bits por segundo del video. */
  bitrate: number;
  tauri: boolean;
  onError: (message: string) => void;
  /** La hora del nombre del archivo, para que coincida con la del iPhone. */
  date?: Date;
};

export class Recording {
  readonly path: string;
  readonly mime: string;
  readonly started = Date.now();
  private recorder: MediaRecorder;
  private sink: Sink;
  /** Los pedazos se escriben en orden, uno detrás del otro. */
  private queue: Promise<void> = Promise.resolve();
  private failed: string | null = null;
  private mic: MediaStream | null = null;

  private constructor(recorder: MediaRecorder, sink: Sink, path: string, mime: string) {
    this.recorder = recorder;
    this.sink = sink;
    this.path = path;
    this.mime = mime;
  }

  static async start(o: RecordOptions): Promise<Recording> {
    const format = pickFormat(o.container, (t) => MediaRecorder.isTypeSupported(t));
    if (!format) throw new Error("Esta vista no puede grabar video.");
    const video = o.video.getVideoTracks()[0];
    const audio = o.audio.getAudioTracks()[0];
    if (!video) throw new Error("La cámara no está mandando video.");
    if (!audio) throw new Error("No hay micrófono.");

    const stream = new MediaStream([video, audio]);
    const recorder = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond: o.bitrate,
      audioBitsPerSecond: 320_000,
    });
    const name = takeName(o.date ?? new Date(), format.ext);
    const { sink, path } = o.tauri ? await tauriSink(name) : browserSink(name, format.mime);
    const rec = new Recording(recorder, sink, path, format.mime);
    rec.mic = o.audio;

    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      rec.queue = rec.queue
        .then(() => sink.write(e.data))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!rec.failed) o.onError(msg);
          rec.failed = msg;
        });
    };
    recorder.onerror = () => o.onError("La grabación se cortó.");
    // Un pedazo por segundo: lo grabado va a disco enseguida.
    recorder.start(1_000);
    return rec;
  }

  /** El micrófono se abrió para esta toma: se cierra con ella. La cámara sigue. */
  stopMic(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
  }

  get seconds(): number {
    return Math.floor((Date.now() - this.started) / 1000);
  }

  async stop(): Promise<Saved> {
    if (this.recorder.state !== "inactive") {
      const done = new Promise<void>((r) => this.recorder.addEventListener("stop", () => r(), { once: true }));
      this.recorder.stop();
      await done;
    }
    await this.queue;
    const saved = await this.sink.close();
    if (this.failed) throw new Error(`Se guardó hasta donde se pudo: ${this.failed}`);
    return saved;
  }
}
