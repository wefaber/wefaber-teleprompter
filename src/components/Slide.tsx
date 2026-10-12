import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { pastEnd, type AudienceState } from "../lib/deck";

type Props = {
  state: AudienceState;
  /** El video llegó al final de su rango o del archivo. */
  onVideoEnd?: () => void;
};

/** Lo que ve el público: la diapositiva, el video o el punto en grande. */
export function Slide({ state, onVideoEnd }: Props) {
  if (state.black) return <div className="h-full w-full bg-black" />;
  if (state.video) return <SlideVideo video={state.video} playing={state.playing} onEnd={onVideoEnd} />;
  if (state.slide?.kind === "imagen")
    return <img src={convertFileSrc(state.slide.path)} alt={state.title} className="h-full w-full object-contain" />;
  if (state.slide?.kind === "html")
    // Sin allow-same-origin: corre su JS pero no toca la app.
    return <iframe title={state.title} src={convertFileSrc(state.slide.path)} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />;
  // Los márgenes van en unidades del contenedor: en la miniatura, `vw` y `vh` se medirían contra la ventana principal.
  return (
    <div className="h-full w-full [container-type:size]">
      <div className="flex h-full w-full flex-col justify-center gap-[4cqh] px-[8cqw]">
        <h1 className="title m-0">{state.title}</h1>
        {state.bullets.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-[2cqh] p-0">
            {state.bullets.map((b, i) => (
              <li key={i} className="bullet flex items-start gap-[0.6em]">
                <span aria-hidden className="mt-[0.5em] size-[0.35em] shrink-0 rounded-full bg-current" />
                <span className="min-w-0">{b}</span>
              </li>
            ))}
          </ul>
        )}
        {state.missing && <p className="note m-0 font-mono opacity-60">No encuentro {state.missing}</p>}
      </div>
    </div>
  );
}

function SlideVideo({ video, playing, onEnd }: { video: NonNullable<AudienceState["video"]>; playing: boolean; onEnd?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // Un pause() justo después de play() rechaza con AbortError: no es el fin del video.
    if (playing) v.play().catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? undefined : onEnd?.()));
    else v.pause();
  }, [playing, onEnd]);
  // `#t=` arranca en el inicio del rango sin esperar a que cargue.
  const src = convertFileSrc(video.path) + (video.start ? `#t=${video.start}` : "");
  return (
    <video
      ref={ref}
      src={src}
      className="h-full w-full bg-black object-contain"
      onTimeUpdate={(e) => {
        if (pastEnd(e.currentTarget.currentTime, video.end)) {
          e.currentTarget.pause();
          onEnd?.();
        }
      }}
      onEnded={() => onEnd?.()}
    />
  );
}
