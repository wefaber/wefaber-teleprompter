import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import type { Doc } from "../lib/script";
import type { SectionTone } from "../lib/llm";
import type { Settings } from "../lib/settings";

type Props = {
  doc: Doc;
  index: number;
  covered: ReadonlySet<number>;
  settings: Settings;
  tones: SectionTone[] | null;
  /** Lugar que ocupa la vista previa de la cámara: el texto no va debajo. */
  reserve: { side: "left" | "right"; width: string } | null;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Lo que se lee: el punto actual grande, sus viñetas y el que sigue. */
export function Stage({ doc, index, covered, settings, tones, reserve }: Props) {
  const point = doc.points[index];
  if (!point) {
    return (
      <div className="grid h-full place-items-center px-8">
        <p className="bullet text-[var(--muted)]">El guion está vacío. Abrilo con E para escribir los puntos.</p>
      </div>
    );
  }
  const section = doc.sections[point.section];
  const next = doc.points[index + 1];
  const nextIsNewSection = next && next.section !== point.section;

  // Bajo la cámara: columna angosta, pegada arriba y centrada en el lente. La
  // mirada se nota desviada a partir de unos 5 grados; cada centímetro cuenta.
  const underLens = settings.position === "camara";
  const column = `min(${settings.width}vw, 40vw)`;
  const wrapper = underLens
    ? "relative h-full w-full"
    : `flex h-full w-full justify-center px-6 ${settings.position === "centro" ? "items-center" : "items-start pt-[max(9vh,4.5rem)]"}`;
  const articleStyle: CSSProperties = underLens
    ? {
        position: "absolute",
        top: "3.25rem",
        width: column,
        left: `clamp(1.25rem, calc(${settings.lensX}vw - ${column} / 2), calc(100vw - ${column} - 1.25rem))`,
      }
    : { maxWidth: `${settings.width}vw` };

  return (
    <div
      className={wrapper}
      style={
        reserve && !underLens ? { [reserve.side === "left" ? "paddingLeft" : "paddingRight"]: `calc(${reserve.width} + 2.5rem)` } : undefined
      }
    >
      {underLens && (
        // Dónde tiene que quedar el teléfono.
        <div
          aria-hidden
          className="absolute top-0 z-[1] h-[7px] w-14 -translate-x-1/2 rounded-b-full bg-[var(--color-signal)]"
          style={{ left: `${settings.lensX}vw` }}
        />
      )}
      <article key={point.id} className={`enter flex w-full flex-col ${underLens ? "gap-[1.8vh]" : "gap-[3.2vh]"}`} style={articleStyle}>
        <div className="eyebrow flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[var(--muted)]">
          <span>
            <span className="font-mono tabular-nums">
              {pad(point.section + 1)}/{pad(doc.sections.length)}
            </span>{" "}
            · {section?.title}
            {tones?.[point.section] && (
              <span className="ml-3 rounded-full border border-current px-[0.7em] py-[0.1em] tracking-[0.08em]">
                {tones[point.section]!.tone}
              </span>
            )}
          </span>
          <span className="font-mono tabular-nums">
            punto {index + 1} de {doc.points.length}
          </span>
        </div>

        <h1 className="title m-0">{point.title}</h1>

        {point.bullets.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-[1.6vh] p-0">
            {point.bullets.map((b, i) => {
              const done = covered.has(i);
              return (
                <li
                  key={i}
                  className="bullet flex items-start gap-[0.6em] transition-opacity duration-500"
                  style={{ opacity: done ? 0.3 : 1 }}
                >
                  <span
                    aria-hidden
                    className="mt-[0.18em] grid size-[0.8em] shrink-0 place-items-center rounded-full border-[0.09em] border-current transition-colors duration-300"
                    style={{ background: done ? "var(--ink)" : "transparent" }}
                  >
                    {done && <Check className="size-[0.55em] text-[var(--bg)]" strokeWidth={4} />}
                  </span>
                  <span className="min-w-0">{b}</span>
                  <span className="sr-only">{done ? "(dicho)" : ""}</span>
                </li>
              );
            })}
          </ul>
        )}

        {point.notes.map((n, i) => (
          <p key={i} className="note m-0 border-l-[3px] border-[var(--color-note)] pl-[0.8em] font-medium text-[var(--color-note)]">
            {n}
          </p>
        ))}

        {next && (
          <section aria-label="Lo que sigue" className="mt-[1.5vh] border-t border-[var(--faint)] pt-[2.2vh] text-[var(--muted)]">
            <p className="eyebrow m-0">
              Después
              {nextIsNewSection && (
                <>
                  {" · "}
                  <span className="font-mono tabular-nums">{pad(next.section + 1)}</span> {doc.sections[next.section]?.title}
                </>
              )}
            </p>
            <p className="next-title m-0 mt-[0.35em]">{next.title}</p>
            {next.bullets.length > 0 && (
              <ul className="next-bullet m-0 mt-[0.5em] flex list-none flex-col gap-[0.3em] p-0">
                {next.bullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-[0.55em]">
                    <span aria-hidden className="mt-[0.55em] size-[0.32em] shrink-0 rounded-full bg-current" />
                    <span className="min-w-0">{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </article>
    </div>
  );
}

/** Barra fina arriba: una franja por sección, del largo de sus puntos. */
export function Progress({ doc, index }: { doc: Doc; index: number }) {
  const total = Math.max(doc.points.length, 1);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[4px] gap-[3px]" aria-hidden>
      {doc.sections.map((s, i) => {
        if (s.first < 0) return null;
        const count = s.last - s.first + 1;
        const fill = index > s.last ? 1 : index < s.first ? 0 : (index - s.first + 1) / count;
        return (
          <div key={i} className="relative h-full bg-[var(--faint)]" style={{ flexGrow: count / total }}>
            <div className="absolute inset-y-0 left-0 bg-[var(--ink)] transition-[width] duration-500" style={{ width: `${fill * 100}%` }} />
          </div>
        );
      })}
    </div>
  );
}
