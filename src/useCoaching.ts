import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Coach, type Hint, type Live, type Prosody } from "./lib/coach";
import { hash, locate, reviewSection, sectionTones, type Review, type SectionStats, type SectionTone, type Transport } from "./lib/llm";
import { words, type Snapshot, type Tracker } from "./lib/match";
import type { Doc } from "./lib/script";
import type { Settings } from "./lib/settings";

export type Note = Review & { section: number; title: string; stats: SectionStats };

type Args = {
  doc: Doc;
  script: string;
  settings: Settings;
  tracker: RefObject<Tracker>;
  setSnap: Dispatch<SetStateAction<Snapshot>>;
  index: number;
  send: Transport | null;
};

const HINT_MS = 9_000;
/** Palabras nuevas antes de volver a preguntarle a DeepSeek dónde estamos. */
const LOCATE_EVERY = 10;
const LOCATE_CONFIDENCE = 0.7;

export function useCoaching({ doc, script, settings, tracker, setSnap, index, send }: Args) {
  const coach = useRef(new Coach());
  const [hint, setHint] = useState<Hint | null>(null);
  const [live, setLive] = useState<Live>({ wpm: null, toneSt: null, spreadSt: null, ready: false });
  const [tones, setTones] = useState<SectionTone[] | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [llmError, setLlmError] = useState<string | null>(null);

  const llm = settings.llm && send !== null;
  const said = useRef<{ section: number; text: string }[]>([]);
  const pending = useRef(0);
  const inflight = useRef(false);
  const offTopic = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const show = useCallback((h: Hint | null) => {
    if (h) setHint(h);
  }, []);

  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);

  const fail = useCallback((e: unknown) => setLlmError(e instanceof Error ? e.message : String(e)), []);

  // Tonos por sección: una vez por guion, guardados por contenido.
  useEffect(() => {
    if (!llm || !send) return setTones(null);
    const key = `apuntador:tonos:${hash(script)}`;
    try {
      const cached = localStorage.getItem(key);
      if (cached) return setTones(JSON.parse(cached) as SectionTone[]);
    } catch {
      // Sin caché, se pide.
    }
    let alive = true;
    sectionTones(send, doc)
      .then((t) => {
        if (!alive) return;
        setTones(t);
        setLlmError(null);
        try {
          localStorage.setItem(key, JSON.stringify(t));
        } catch {
          // Idem.
        }
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [llm, send, script, doc, fail]);

  // Al cambiar de sección: devolución de la que terminó y tono de la nueva.
  const section = doc.points[index]?.section ?? 0;
  const prevSection = useRef(section);
  useEffect(() => {
    const prev = prevSection.current;
    prevSection.current = section;
    if (prev === section) return;

    const tone = tones?.[section];
    if (tone) {
      const name = doc.sections[section]?.title ?? "";
      show({ kind: "seccion", text: `${name}: ${tone.tone}. ${tone.tip}`, say: `${name}: ${tone.tone}`, t: Date.now() });
    }

    const text = said.current
      .filter((s) => s.section === prev)
      .map((s) => s.text)
      .join(" ");
    if (!llm || !send || words(text).length < 15) return;
    const stats = coach.current.summary(prev);
    reviewSection(send, doc, prev, text, stats, tones?.[prev])
      .then((r) => {
        if (!r.note && !r.tip) return;
        setNotes((n) => [...n, { ...r, section: prev, title: doc.sections[prev]?.title ?? "", stats }]);
      })
      .catch(fail);
  }, [section, tones, llm, send, doc, show, fail]);

  const onFinal = useCallback(
    (text: string, prosody: Prosody | null) => {
      const now = Date.now();
      const t = tracker.current;
      const sec = doc.points[t.index]?.section ?? 0;
      const entry = { section: sec, text };
      said.current.push(entry);
      if (said.current.length > 400) said.current.shift();

      const utterance = prosody ? { ...prosody, t: now, words: words(text).length, section: sec } : null;
      if (utterance) {
        const h = coach.current.push(utterance);
        if (settingsRef.current.coach) show(h);
        setLive(coach.current.live(now));
      }

      pending.current += words(text).length;
      if (!llm || !send || inflight.current || pending.current < LOCATE_EVERY) return;
      pending.current = 0;
      inflight.current = true;
      const asked = t.index;
      const before = said.current
        .slice(-3, -1)
        .map((s) => s.text)
        .join(" ");
      locate(send, doc, asked, before, text)
        .then((r) => {
          setLlmError(null);
          const tr = tracker.current;
          if (r.offTopic) {
            offTopic.current++;
            if (offTopic.current >= 3 && coach.current.allow("punto", Date.now())) {
              const next = doc.points[tr.index]?.title;
              show({ kind: "punto", text: `Hace un rato que no tocás los puntos. Seguís en: ${next}.`, say: `Volvé a: ${next}`, t: Date.now() });
              offTopic.current = 0;
            }
            return;
          }
          offTopic.current = 0;
          if (r.point === null || r.confidence < LOCATE_CONFIDENCE) return;
          // Si mientras tanto se movió por palabras clave o a mano, eso manda.
          if (tr.index !== asked) return;
          if (r.point !== tr.index && settingsRef.current.auto) {
            // Vota como una frase más: el siguiente pasa, lo lejano espera
            // que lo que se diga después coincida.
            const snap = tr.propose(r.point, Date.now());
            if (snap.index === r.point) {
              // La frase era del punto nuevo: que cuente para su sección, no
              // para la devolución de la que se está cerrando.
              const moved = doc.points[r.point]?.section ?? entry.section;
              entry.section = moved;
              if (utterance) utterance.section = moved;
            }
            setSnap(snap);
          }
          if (r.point === tr.index && r.bullets.length) setSnap(tr.cover(r.bullets));
        })
        .catch(fail)
        .finally(() => {
          inflight.current = false;
        });
    },
    [doc, llm, send, tracker, setSnap, show, fail],
  );

  const reset = useCallback(() => {
    coach.current.reset();
    said.current = [];
    setNotes([]);
    setLive({ wpm: null, toneSt: null, spreadSt: null, ready: false });
  }, []);

  return { hint, dismissHint: () => setHint(null), notify: show, live, tones, notes, llmError, onFinal, reset };
}
