import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Solo en `bun run dev`: la interfaz suelta en el navegador no tiene Rust, así
 * que este proxy hace de `llm_json`. La clave queda en el proceso de Vite y no
 * llega a la página. `GET` dice si hay clave; `POST` manda el pedido.
 */
function devLlm(): Plugin {
  return {
    name: "apuntador-dev-llm",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/llm", async (req, res) => {
        const key = process.env.DEEPSEEK_API_KEY;
        if (!key) {
          res.statusCode = 503;
          return res.end("Falta DEEPSEEK_API_KEY en el entorno");
        }
        if (req.method === "GET") return res.end("ok");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { system, user, maxTokens } = JSON.parse(raw) as { system: string; user: string; maxTokens: number };
        const r = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-flash",
            thinking: { type: "disabled" },
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        const body = (await r.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
        res.statusCode = r.ok ? 200 : 502;
        res.end(r.ok ? (body.choices?.[0]?.message.content ?? "") : (body.error?.message ?? `DeepSeek respondió ${r.status}`));
      });
    },
  };
}

// localhost es contexto seguro: Chrome deja usar el micrófono y el
// reconocimiento de voz sin https.
export default defineConfig({
  plugins: [react(), tailwindcss(), devLlm()],
  server: { host: "localhost", port: 5180, strictPort: true },
  preview: { host: "localhost", port: 5180, strictPort: true },
});
