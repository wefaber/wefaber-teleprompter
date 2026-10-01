import { useCallback, useEffect, useRef, useState } from "react";
import type { Hint } from "./lib/coach";
import type { Settings } from "./lib/settings";
import { inTauri } from "./lib/speech";
import { Announcer, EdgeSpeaker, SystemSpeaker, audioOutput, isHeadphones, type Speaker } from "./lib/voice";

/** Cada cuánto se mira si cambiaron los auriculares (AirPods que se conectan). */
const OUTPUT_EVERY = 4_000;
const TICK_MS = 150;

type Args = {
  settings: Settings;
  /** El consejo que se está mostrando, ya filtrado por lo que está prendido. */
  hint: Hint | null;
  /** Si estás hablando ahora (del nivel del micrófono). */
  speaking: boolean;
};

function makeSpeaker(voice: string): Speaker {
  if (voice.startsWith("edge:") && inTauri()) return new EdgeSpeaker(voice.slice("edge:".length));
  return new SystemSpeaker();
}

export function useVoiceCoach({ settings, hint, speaking }: Args) {
  const mode = settings.voiceMode;
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "apagada" || !inTauri()) return;
    let alive = true;
    const look = () =>
      audioOutput()
        .then((o) => alive && setOutput(o))
        .catch(() => alive && setOutput(null));
    void look();
    const id = setInterval(look, OUTPUT_EVERY);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mode]);

  const headphones = isHeadphones(output);
  const enabled = mode === "siempre" || (mode === "auriculares" && headphones);

  const speaker = useRef<Speaker | null>(null);
  const fallback = useRef<Speaker>(new SystemSpeaker());
  useEffect(() => {
    const s = makeSpeaker(settings.voice);
    speaker.current = s;
    setError(null);
    return () => {
      if (s instanceof EdgeSpeaker) s.dispose();
      else s.stop();
    };
  }, [settings.voice]);

  /** Si Edge falla (sin internet, o cambió el servicio), dice lo mismo con la de Windows. */
  const say = useCallback(async (text: string) => {
    const s = speaker.current;
    if (!s) return;
    try {
      await s.speak(text);
    } catch (e) {
      if (s instanceof SystemSpeaker) return;
      setError(`${e instanceof Error ? e.message : String(e)}. Uso la voz de Windows.`);
      await fallback.current.speak(text);
    }
  }, []);

  const announcer = useRef(new Announcer());
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    if (!enabled || !hint) return;
    announcer.current.push(hint.say ?? hint.text, Date.now());
  }, [hint, enabled]);

  useEffect(() => {
    if (!enabled) {
      announcer.current.reset();
      speaker.current?.stop();
      return;
    }
    const a = announcer.current;
    const id = setInterval(() => {
      const text = a.tick(Date.now(), speakingRef.current);
      if (text) void say(text).finally(() => a.done(Date.now()));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [enabled, say]);

  const test = useCallback(() => void say("Así suena la voz del coach. Más lento."), [say]);

  return { output, headphones, enabled, error, test };
}
