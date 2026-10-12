import { emitTo, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Slide } from "./components/Slide";
import { EMPTY_AUDIENCE, type AudienceState } from "./lib/deck";

/**
 * La ventana del público. Muestra lo que manda la principal y le devuelve el
 * fin del video y las teclas: si alguien toca esta ventana, el clicker sigue
 * mandando en la principal.
 */
export function Audience() {
  const [state, setState] = useState<AudienceState>(EMPTY_AUDIENCE);

  useEffect(() => {
    document.body.style.background = "#000";
    // Primero escuchar, después pedir el estado: si no, la respuesta llega antes.
    const off = listen<AudienceState>("audiencia:estado", (e) => setState(e.payload));
    void off.then(() => emitTo("main", "audiencia:lista"));
    const onKey = (e: KeyboardEvent) => {
      // Con modificadores (Ctrl+R, Alt+F4…) la tecla es del sistema, no del presentador; y no se repite.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) void emitTo("main", "audiencia:tecla", e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onVideoEnd = useCallback(() => void emitTo("main", "audiencia:video-fin"), []);

  return (
    <main className="h-full w-full cursor-none bg-black text-white">
      <Slide key={state.id} state={state} onVideoEnd={onVideoEnd} />
    </main>
  );
}
