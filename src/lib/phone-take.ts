/**
 * La toma que graba el teléfono: qué formato usar y cómo subir los pedazos a
 * la PC en orden, reintentando, sin perder ni repetir ninguno. Lo usa la
 * página del iPhone (phone/main.ts); está acá para poder probarlo.
 */

/** Del mejor al peor. Safari graba MP4 con H.264 y AAC. */
const PHONE_FORMATS = [
  "video/mp4;codecs=avc1.640033,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

export type PhoneFormat = { mime: string; ext: "mp4" | "webm" };

/**
 * Los que el navegador dice soportar, en orden. Hay que probarlos: alguno
 * dice que sí y después el codificador no arranca.
 */
export function phoneFormats(supported: (mime: string) => boolean): PhoneFormat[] {
  return PHONE_FORMATS.filter(supported).map((mime) => ({ mime, ext: mime.startsWith("video/mp4") ? "mp4" : "webm" }));
}

/** Qué contestó la PC a un pedazo. */
export type PostResult = { ok: true } | { gone: true } | { expected: number } | { retry: string };

export type UploadResult = { chunks: number; bytes: number; error: string | null };

type Options = {
  post: (seq: number, chunk: Blob) => Promise<PostResult>;
  onProgress?: (sentBytes: number, pending: number) => void;
  /** La PC ya no tiene la toma: dejar de grabar. */
  onGone?: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Ya terminada la toma, cuánto seguir reintentando antes de rendirse. */
  giveUpMs?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Uploader {
  private queue: Blob[] = [];
  private seq = 0;
  private sentBytes = 0;
  private running = false;
  private closed = false;
  private result: UploadResult | null = null;
  private resolve!: (r: UploadResult) => void;
  readonly done: Promise<UploadResult>;
  private o: Required<Omit<Options, "onProgress" | "onGone">> & Pick<Options, "onProgress" | "onGone">;

  constructor(o: Options) {
    this.o = { wait: sleep, now: Date.now, giveUpMs: 120_000, ...o };
    this.done = new Promise((r) => (this.resolve = r));
  }

  get pending(): number {
    return this.queue.length;
  }

  push(chunk: Blob): void {
    if (this.result || this.closed || !chunk.size) return;
    this.queue.push(chunk);
    void this.pump();
  }

  /** No hay más pedazos: sube lo que falta y termina. */
  close(): Promise<UploadResult> {
    this.closed = true;
    void this.pump();
    return this.done;
  }

  private finish(error: string | null) {
    if (this.result) return;
    this.queue = [];
    this.result = { chunks: this.seq, bytes: this.sentBytes, error };
    this.resolve(this.result);
  }

  private async pump() {
    if (this.running || this.result) return;
    this.running = true;
    let failingSince: number | null = null;
    let delay = 500;
    while (this.queue.length && !this.result) {
      const chunk = this.queue[0]!;
      const r = await this.o.post(this.seq, chunk);
      if ("ok" in r) {
        this.queue.shift();
        this.seq += 1;
        this.sentBytes += chunk.size;
        failingSince = null;
        delay = 500;
        this.o.onProgress?.(this.sentBytes, this.queue.length);
      } else if ("gone" in r) {
        this.finish("La PC cerró la toma");
        this.o.onGone?.();
      } else if ("expected" in r) {
        // Lo que la PC espera ya se mandó y se descartó: no hay forma de reponerlo.
        this.finish(`Se perdió el pedazo ${r.expected} de la toma`);
      } else {
        failingSince ??= this.o.now();
        if (this.closed && this.o.now() - failingSince > this.o.giveUpMs) {
          this.finish(`No pude mandar la toma a la PC: ${r.retry}`);
          break;
        }
        await this.o.wait(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
    this.running = false;
    if (this.closed && !this.queue.length) this.finish(null);
  }
}
