import type { Aspect, Rotation } from "./camera";
import type { PhoneRoute } from "./phone-link";
import type { Facing } from "./phone-protocol";
import type { Container } from "./recorder";
import type { VoiceId, VoiceMode } from "./voice";
import type { Accel, EngineMode } from "./engine";

/** Valor de cameraDevice para usar el iPhone por la red en vez de una webcam. */
export const PHONE_CAMERA = "iphone";
import type { Sensitivity } from "./match";

export type LightPreset = { id: string; label: string; color: string; kelvin?: string };

/** Como whitescreen: el monitor es la luz. Los tonos van de frío a cálido. */
export const LIGHTS: LightPreset[] = [
  { id: "frio", label: "Frío", color: "#EEF3FF", kelvin: "7500K" },
  { id: "blanco", label: "Blanco", color: "#FFFFFF", kelvin: "6500K" },
  { id: "neutro", label: "Neutro", color: "#FFF6EA", kelvin: "5000K" },
  { id: "calido", label: "Cálido", color: "#FFE6C4", kelvin: "3500K" },
  { id: "vela", label: "Vela", color: "#FFD29A", kelvin: "2700K" },
];

export type Settings = {
  light: string;
  brightness: number;
  textScale: number;
  /** "camara": una columna angosta pegada debajo del lente, para no mirar lejos de él. */
  position: "arriba" | "centro" | "camara";
  /** Dónde está la cámara sobre el monitor, en % del ancho desde la izquierda. */
  lensX: number;
  width: number;
  sensitivity: Sensitivity;
  auto: boolean;
  transcript: boolean;
  device: string;
  /** Consejos de ritmo, tono y volumen. */
  coach: boolean;
  /** DeepSeek: seguir por el sentido, tono por sección y devolución. */
  llm: boolean;
  /** Vista previa de la cámara (DroidCam o la que sea). */
  camera: boolean;
  cameraDevice: string;
  cameraCorner: Corner;
  /** Ancho de la vista previa, en % de la ventana. */
  cameraWidth: number;
  /** El recorte que se ve. DroidCam manda 16:9. */
  cameraFormat: Aspect;
  /** Tamaño de captura ("1920x1080"); vacío prueba hasta que llega imagen. */
  cameraMode: string;
  cameraRotate: Rotation;
  cameraMirror: boolean;
  cameraGuides: boolean;
  /** Consejos de luz, lente y foco mirando la imagen. */
  cameraAdvice: boolean;
  /** Micrófono para grabar (id del navegador; el de la voz es otro sistema). */
  recordMic: string;
  recordContainer: Container;
  /** Megabits por segundo del video. */
  recordMbps: number;
  /** Con el iPhone: trasera (mejor imagen) o frontal (el guion en el teléfono). */
  phoneFacing: Facing;
  /** "temporal": link por internet (Tailscale Funnel) para cuando el teléfono no resuelve la tailnet. */
  phoneRoute: PhoneRoute;
  /** Al grabar, el iPhone graba también a resolución completa y manda el archivo. */
  phoneRecord: boolean;
  /** La voz del coach por los auriculares. */
  voiceMode: VoiceMode;
  voice: VoiceId;
  /** Dónde se reconoce la voz: esta PC, otra de la tailnet o xAI. */
  sttMode: EngineMode;
  /** Forzar un acelerador en esta PC; vacío usa el de la medición. */
  sttAccel: Accel | "";
  /** La otra PC: https://pc.tailnet.ts.net:5191 y su clave. */
  sttRemoteUrl: string;
  sttRemoteKey: string;
};

export type Corner = "abajo-der" | "abajo-izq" | "arriba-der" | "arriba-izq";

export const DEFAULTS: Settings = {
  light: "#FFFFFF",
  brightness: 100,
  textScale: 1,
  position: "arriba",
  lensX: 50,
  width: 62,
  sensitivity: "media",
  auto: true,
  transcript: true,
  device: "",
  coach: true,
  llm: true,
  camera: false,
  cameraDevice: "",
  cameraCorner: "abajo-der",
  cameraWidth: 32,
  cameraFormat: "16:9",
  cameraMode: "",
  cameraRotate: 0,
  cameraMirror: true,
  cameraGuides: true,
  cameraAdvice: true,
  recordMic: "",
  recordContainer: "mkv",
  recordMbps: 40,
  phoneFacing: "environment",
  phoneRoute: "temporal",
  phoneRecord: true,
  voiceMode: "auriculares",
  voice: "edge:es-AR-TomasNeural",
  sttMode: "auto",
  sttAccel: "",
  sttRemoteUrl: "",
  sttRemoteKey: "",
};

const KEY = "apuntador:ajustes";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Sin almacenamiento, los ajustes duran lo que dura la sesión.
  }
}

/** Color de fondo con el brillo aplicado, y tinta que se lea encima. */
export function surface(hex: string, brightness: number): { bg: string; ink: string; dark: boolean } {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const f = brightness / 100;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c * f)) as [
    number,
    number,
    number,
  ];
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const dark = lum < 0.18;
  return { bg: `rgb(${r} ${g} ${b})`, ink: dark ? "#F4F1EA" : "#1A1813", dark };
}
