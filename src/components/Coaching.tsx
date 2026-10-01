import { AudioLines, Camera, Gauge, Megaphone, Route, Sparkles, Volume2, X } from "lucide-react";
import type { Hint, HintKind } from "../lib/coach";
import type { SectionTone } from "../lib/llm";
import type { Doc } from "../lib/script";
import type { Note } from "../useCoaching";

const ICON: Record<HintKind, typeof Gauge> = {
  ritmo: Gauge,
  tono: AudioLines,
  expresion: Megaphone,
  volumen: Volume2,
  seccion: Sparkles,
  punto: Route,
  camara: Camera,
};

/** El consejo del momento: abajo, legible de reojo, se va solo. */
export function HintPill({ hint, onDismiss }: { hint: Hint | null; onDismiss: () => void }) {
  if (!hint) return null;
  const Icon = ICON[hint.kind];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center px-6" role="status" aria-live="polite">
      <div
        key={hint.t}
        className="enter pointer-events-auto flex max-w-[min(56rem,90vw)] items-center gap-[0.7em] rounded-2xl border-2 border-[var(--ink)] bg-[var(--bg)] px-[1em] py-[0.6em] shadow-[0_10px_40px_rgb(0_0_0/0.12)]"
        style={{ fontSize: "calc(clamp(1rem, 1.6vw, 1.7rem) * var(--scale))" }}
      >
        <Icon className="size-[1.2em] shrink-0" aria-hidden />
        <span className="min-w-0 text-pretty">{hint.text}</span>
        <button type="button" onClick={onDismiss} className="grid size-[1.6em] shrink-0 place-items-center rounded-full hover:bg-[var(--faint)]" aria-label="Descartar consejo">
          <X className="size-[0.9em]" />
        </button>
      </div>
    </div>
  );
}

export function Notes({ notes, doc, tones, llm }: { notes: Note[]; doc: Doc; tones: SectionTone[] | null; llm: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {notes.length === 0 && (
        <p className="m-0 text-sm text-[var(--muted)]">
          {llm
            ? "Al terminar cada sección aparece acá una devolución: qué quedó claro, qué faltó y qué probar en la próxima toma."
            : "Las devoluciones por sección usan DeepSeek. Prendelo en Ajustes → Coach."}
        </p>
      )}
      {notes.map((n, i) => (
        <article key={i} className="flex flex-col gap-2 border-b border-[var(--faint)] pb-5 last:border-0">
          <h3 className="m-0 font-display text-lg font-bold">{n.title}</h3>
          <p className="m-0 flex flex-wrap gap-x-3 font-mono text-xs tabular-nums text-[var(--muted)]">
            {n.stats.wpm !== null && <span>{n.stats.wpm} ppm</span>}
            {n.stats.spreadSt !== null && <span>variación {n.stats.spreadSt.toFixed(1)} st</span>}
            {n.stats.toneSt !== null && (
              <span>
                tono {n.stats.toneSt >= 0 ? "+" : "−"}
                {Math.abs(n.stats.toneSt).toFixed(1)} st
              </span>
            )}
            <span>{n.stats.seconds} s</span>
          </p>
          {n.note && <p className="m-0 text-sm">{n.note}</p>}
          {n.tip && (
            <p className="m-0 border-l-[3px] border-[var(--ink)] pl-3 text-sm font-medium">{n.tip}</p>
          )}
        </article>
      ))}
      {tones && (
        <section>
          <h3 className="eyebrow m-0 mb-3 text-[0.72rem] font-bold text-[var(--muted)]">Tono por sección</h3>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {doc.sections.map((s, i) => (
              <div key={i} className="contents">
                <dt className="font-medium">{s.title}</dt>
                <dd className="m-0 text-[var(--muted)]">
                  <strong className="text-[var(--ink)]">{tones[i]?.tone}</strong> · {tones[i]?.tip}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
