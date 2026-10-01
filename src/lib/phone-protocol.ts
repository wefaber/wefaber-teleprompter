/**
 * Lo que se dicen la PC y el iPhone por /ws (ver src-tauri/src/phone.rs).
 * El servidor solo pasa los mensajes de un lado al otro y avisa quién está.
 * La imagen va por WebRTC, directo entre los dos.
 *
 * Lo habla la página del teléfono (phone/main.ts). Una app nativa de iOS
 * puede hablar lo mismo: con eso la PC no cambia.
 *
 * Orden: el teléfono abre la cámara y manda `offer`; la PC contesta
 * `answer`; los dos se pasan `ice`. Cambiar de cámara no rearma la
 * conexión: el teléfono reemplaza la pista de video.
 *
 * Grabar: la PC manda `record`; el teléfono graba la cámara a resolución
 * completa con su micrófono, contesta `recording` y sube la toma en pedazos
 * de un segundo por POST /rec?t=…&take=…&seq=…&ext=… (204 escrito, 404 la
 * toma ya no existe, 409 {expected} falta uno anterior). Avisa cómo va con
 * `upload`. Con `record-stop` termina, sube lo que falte y manda
 * `recorded`. Mientras graba no cambia de cámara.
 */

export type Facing = "environment" | "user";

/** El punto actual, para leerlo en el teléfono con la cámara frontal. */
export type PhoneScript = {
  section: string;
  title: string;
  bullets: string[];
  covered: number[];
  /** Título del punto que sigue. */
  next: string | null;
  /** Sus viñetas, como el "Después" de la PC. */
  nextBullets?: string[];
  /** La sección del que sigue, solo si cambia. */
  nextSection?: string | null;
  index: number;
  total: number;
};

/** Del servidor a cualquiera de los dos: si el otro está conectado. */
export type PeerMessage = { type: "peer"; connected: boolean };

export type ToPhone =
  | PeerMessage
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "facing"; facing: Facing }
  | { type: "script"; script: PhoneScript | null }
  /**
   * El tiempo de la toma al momento de mandarlo; el teléfono sigue contando
   * solo. Llega con cada cambio y cada tanto, para no desfasarse.
   */
  | { type: "clock"; elapsedMs: number; running: boolean; recMs: number | null }
  /** Con la frontal la pantalla del teléfono suma luz: este color. */
  | { type: "light"; color: string }
  /** La PC perdió la imagen: que el teléfono vuelva a ofrecer. */
  | { type: "restart" }
  /** Empezar a grabar en el teléfono. `take`: solo letras y números. */
  | { type: "record"; take: string; bitrate: number }
  | { type: "record-stop"; take: string };

export type ToPc =
  | PeerMessage
  | { type: "hello"; device: string }
  | { type: "offer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "status"; facing: Facing; width: number; height: number; error: string | null }
  /** Arrancó (con el formato) o no pudo. */
  | { type: "recording"; take: string; mime: string | null; error: string | null }
  /** Lo subido hasta ahora y los pedazos que esperan. */
  | { type: "upload"; take: string; sentBytes: number; pending: number }
  /** Terminó de subir todo, o hasta donde pudo. */
  | { type: "recorded"; take: string; chunks: number; bytes: number; error: string | null };

export const PHONE_PORT = 5190;

export function parse<T extends { type: string }>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    const msg = JSON.parse(data) as T;
    return typeof msg?.type === "string" ? msg : null;
  } catch {
    return null;
  }
}
