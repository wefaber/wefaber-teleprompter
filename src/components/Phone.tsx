import { useEffect, useMemo, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { IDLE, PhoneLink, phoneInfo, phonePublic, type LinkState, type PhoneInfo, type PhoneRoute } from "../lib/phone-link";
import { inTauri } from "../lib/speech";

/** El enlace con el iPhone mientras está elegido como cámara. */
export function usePhone(active: boolean, route: PhoneRoute) {
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<LinkState>(IDLE);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const link = useRef<PhoneLink | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!inTauri()) {
      setError("La cámara del iPhone funciona en la app, no en el navegador.");
      return;
    }
    let alive = true;
    let current: PhoneLink | null = null;
    setError(null);
    phoneInfo()
      .then((i) => {
        if (!alive) return;
        // Si el link temporal ya contestó, su dirección manda.
        setInfo((prev) => prev ?? i);
        current = new PhoneLink(i.token, { onStream: setStream, onState: setState });
        link.current = current;
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      current?.stop();
      link.current = null;
      setInfo(null);
      setStream(null);
      setState(IDLE);
    };
  }, [active]);

  // El link temporal: abierto solo mientras el iPhone está elegido. Cambiar la
  // ruta no corta al teléfono que ya está conectado, solo cambia el QR.
  useEffect(() => {
    if (!active || !inTauri() || route !== "temporal") return;
    let alive = true;
    phonePublic(true)
      .then((i) => alive && setInfo(i))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      void phonePublic(false)
        .then((i) => setInfo((prev) => (prev ? i : prev)))
        .catch(() => {});
    };
  }, [active, route]);

  return { info, error, state, stream, link };
}

/** Lo que se ve en la caja de la vista previa hasta que llega la imagen. */
type WaitingProps = {
  info: PhoneInfo | null;
  error: string | null;
  state: LinkState;
  route: PhoneRoute;
  onRoute: (r: PhoneRoute) => void;
};

export function PhoneWaiting({ info, error, state, route, onRoute }: WaitingProps) {
  const svg = useMemo(() => (info?.url ? renderSVG(info.url, { border: 1 }) : null), [info?.url]);
  const problem = error ?? info?.error ?? state.error;

  if (state.phone) {
    return <span className="text-sm text-white/85">iPhone conectado. Esperando la imagen…</span>;
  }
  return (
    <div className="flex h-full w-full items-center justify-center gap-4 p-3 text-left text-white/85">
      {svg && (
        <div
          className="aspect-square h-full max-h-44 shrink-0 rounded-lg bg-white p-1 [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          role="img"
          aria-label="QR para abrir la cámara en el iPhone"
          // El SVG lo arma uqr con nuestra propia dirección.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <div className="flex min-w-0 flex-col gap-1.5 text-xs">
        <p className="m-0 text-sm font-bold text-white">Cámara del iPhone</p>
        {problem ? (
          <p className="m-0 text-[var(--color-signal)]">{problem}</p>
        ) : route === "temporal" ? (
          <p className="m-0">
            Escaneá el QR con la cámara del iPhone y tocá Conectar. Link temporal: se cierra al cambiar de cámara o cerrar la app. Mismo WiFi que la PC.
          </p>
        ) : (
          <p className="m-0">Escaneá el QR con la cámara del iPhone y tocá Conectar. Los dos tienen que estar en Tailscale.</p>
        )}
        {route === "temporal" && !info?.public && !problem && <p className="m-0 text-white/60">Abriendo el link temporal…</p>}
        {!state.server && !problem && <p className="m-0 text-white/60">Arrancando el servidor…</p>}
        <button
          type="button"
          onClick={() => onRoute(route === "temporal" ? "tailnet" : "temporal")}
          className="self-start rounded-md border border-white/40 px-2 py-1 text-white hover:bg-white/10"
        >
          {route === "temporal" ? "Usar la tailnet" : "¿No abre? Usar un link temporal"}
        </button>
      </div>
    </div>
  );
}
