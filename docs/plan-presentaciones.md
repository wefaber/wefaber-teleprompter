# Plan: presentaciones, agentes y lenguaje corporal

Estado: propuesta, sin implementar. Fecha: 2026-10-11.

Hoy Apuntador sigue un guion por puntos con la voz. El pedido suma tres cosas:

1. Presentar **diapositivas guiadas por voz**, por temas, con **videos** dentro.
2. Que **agentes externos** (Apolo, vía OpenWebUI) hablen, generen UIs y armen
   presentaciones desde **archivos externos**, con las reglas de **WeGraph** y
   los documentos indexados con **EmbeddingGemma**.
3. Un modelo de **lenguaje corporal** (postura, gestos, mirada) que evalúe la
   toma y alimente a **MindVault**, **Apolo** y **WeGraph**.

Tiempos en horas de trabajo del agente, no de una persona. Cada tarea dice
además qué la frena de verdad (hardware, datos, revisión).

## La idea que ordena todo

**Un punto del guion es una diapositiva.** `match.ts` ya decide cuándo pasar de
punto por lo que decís; si cada punto trae su diapositiva, avanzar el punto es
avanzar la diapositiva. No hace falta otro motor de seguimiento. Las secciones
(`#`) ya son los temas.

Lo nuevo es **quién ve qué**:

| Ventana | Quién la mira | Qué muestra |
|---|---|---|
| Presentador (la de hoy) | vos | punto actual, viñetas, notas, coach, miniatura de la diapositiva |
| Audiencia (nueva) | el público, en el proyector o la segunda pantalla | solo la diapositiva o el video |

Y el formato del guion es el **contrato** con los agentes: lo que genere Apolo
es un guion de Apuntador, que una persona revisa antes de usar.

## Prioridades

| Prioridad | Qué | Por qué |
|---|---|---|
| **P0, ahora** | Diapositivas, video, ventana de audiencia y modo presentación | Sin esto no hay presentación. Todo lo demás se muestra acá. |
| P1, ahora si sobra | Miniaturas en la vista del presentador | Ayuda, no bloquea: el punto actual ya se ve. |
| Roadmap | API para agentes, generar desde archivos, escucha de escenario, lenguaje corporal, aprendizaje | Ninguno es necesario para presentar. Dependen de que exista P0. |

**En vivo, un salto equivocado lo ve todo el público.** Grabando, un error de
seguimiento se corta en la edición; presentando, no. Por eso el modo
presentación es P0: por voz solo se avanza al siguiente, los saltos van a mano
(clicker o teclado).

## Ahora: lo que hace falta para presentar

Formato, compatible con los guiones de hoy:

```
# Tema
## Punto
claves: ...
- viñeta (la ve solo el presentador)
diapo: media/portada.png      # imagen o .html del mazo
video: media/demo.mp4 0:12-0:40 auto
nota: ...
```

Un punto sin `diapo:` muestra su título y viñetas como diapositiva simple.

### Tareas, en orden de dependencia

| # | Tarea | Depende de | Código | Freno |
|---|---|---|---|---|
| T1 | **Parser**: `diapo:` y `video:` (archivo, rango opcional, `auto`) en `Point` (`src/lib/script.ts`), con tests | — | 20 min | — |
| T2 | **Mazo = carpeta** (`guion.md` + `media/`): elegir carpeta con `tauri-plugin-dialog`, comando Rust que lee el guion y habilita la carpeta en el scope del protocolo de assets (`protocol-asset`), `library.ts` guarda la ruta | T1 | 1 h | compilar Rust |
| T3 | **Componente `Slide`**: imagen, video, HTML en `iframe` aislado, y la diapositiva simple (título + viñetas) | T1, T2 | 45 min | — |
| T4 | **Ventana de audiencia**: segunda `WebviewWindow` (`?vista=audiencia`), a pantalla completa en el segundo monitor si hay; recibe punto y órdenes por eventos de Tauri; atajo P. Permisos nuevos en `capabilities/` | T3 | 1 h | probar con segundo monitor o proyector |
| T5 | **Video**: arranca al entrar al punto si dice `auto`; mientras suena se ignoran las frases (el micrófono levanta el audio del video); Espacio pausa/sigue; al terminar vuelve a seguir | T3, T4 | 45 min | probar con parlantes reales |
| T6 | **Modo presentación**: por voz solo el siguiente, saltos a mano; B pone negro en la audiencia | T4 | 30 min | — |
| T7 | (P1) **Miniaturas** de la diapositiva actual y la siguiente en la vista del presentador | T3 | 30 min | — |
| T8 | **Mazo real y ensayo completo** de la presentación, de punta a punta | T1–T6 | 1 h armar el mazo | un ensayo tuyo con el equipo real |
| T9 | **Release v0.3.0** por tag (`release.yml`) e instalar desde Actualizaciones | T8 | 15 min | CI y tu revisión del PR |

```
T1 ─> T2 ─> T3 ─┬─> T4 ─┬─> T5 ─┐
                │       └─> T6 ─┼─> T8 ─> T9
                └─> T7 (P1) ····┘
```

Código: unas 5 h. Un PR (`feat/diapositivas`), con T7 adentro si entra.

Plan de implementación paso a paso, con el código ya validado:
[`docs/plans/2026-10-11-diapositivas.md`](plans/2026-10-11-diapositivas.md).

## Roadmap

Orden por prioridad, respetando dependencias:

| # | Qué | Depende de | Código | Freno |
|---|---|---|---|---|
| R1 | API de control para agentes | P0 | 1–2 h | estado de OpenWebUI en el VPS |
| R2 | Escucha de escenario (eco y quién habla) | — | 4–5 h | probar en una sala real con parlantes |
| R3 | Generar presentaciones desde archivos | R1 | 1–5 h | dónde están indexados los documentos |
| R4 | Lenguaje corporal | — | 2–3 h | 10 a 20 tomas grabadas y etiquetadas por vos |
| R5 | Aprendizaje con MindVault, Apolo y WeGraph | R4 | ~1 h | aprobar qué sube |

R1 va primero porque por ahí entra todo lo que generan los agentes. R2 antes
que R3 porque es lo que falló en vivo con Apolo y Ether.

### R1 · API de control para agentes

Mismo patrón que `share.rs`: servidor en `127.0.0.1:5192`, publicado con
`tailscale serve` solo en la tailnet, con clave.

| Ruta | Qué hace |
|---|---|
| `GET /estado` | mazo, punto, sección, últimas frases transcriptas |
| `POST /mazo` | carga un guion generado (queda como borrador hasta aceptarlo) |
| `POST /ir` | ir a un punto o tema |
| `POST /ui` | muestra una UI generada (HTML) como diapositiva |

- Publica un **OpenAPI**: OpenWebUI lo usa como *tool server* sin código
  extra. El mismo servidor puede exponer MCP para Ether, Claude y Hermes.
- **UIs generadas**: `iframe` con `sandbox="allow-scripts"` (sin
  `allow-same-origin`) y CSP `default-src 'none'`: corre su JS pero no sale a
  la red ni toca la app. Primero aparecen en la ventana del presentador; una
  tecla las pasa a la audiencia. Regla de la casa: lo que genera un modelo es
  un borrador hasta que una persona lo acepta.
- **Apolo en escena**: MindVault ya tiene el modo presentador (Ether y Apolo
  activados por nombre, `src/voice/presenter.ts`). Se le suman dos tools,
  `mostrar_diapo` y `mostrar_ui`, que llaman a esta API.

### R2 · Escucha de escenario

El problema, visto en las presentaciones de Apolo y Ether: el agente se
escuchaba por el parlante y se contestaba, y no distinguía al presentador del
público. MindVault hoy lo resuelve a mano: no escucha mientras habla un agente
(más 600 ms), filtra el eco por palabras repetidas y baja el volumen cuando le
hablan encima.

**PersonaPlex** (NVIDIA, [arXiv 2602.06053](https://arxiv.org/html/2602.06053v1),
enero 2026) no resuelve ninguno de los dos: no trata el eco (supone el canal del
usuario limpio) ni quién habla (es de a dos, un usuario y un agente con un rol).
Resuelve otra cosa, la naturalidad: pausas, "ajá" y cortes cuando lo
interrumpen, aprendidos y no por reglas. Hoy no sirve para Apolo: solo inglés,
sin tools (perdería la memoria de MindVault) y probado en A100 de 80 GB. Vale
seguirlo para cuando haya versión multilingüe con tools.

Lo que sí resuelve los dos problemas, con piezas que existen:

1. **Cancelación de eco con referencia.** La app reproduce la voz del agente,
   así que sabe qué salió por el parlante y lo resta del micrófono antes de
   transcribir (procesamiento de audio de WebRTC). Permite volver a escuchar
   mientras el agente habla.
2. **Quién habla, por huella de voz.** Unos segundos de tu voz como referencia;
   cada frase se compara (embeddings de hablante en ONNX, como Parakeet): vos,
   público o un agente (las voces de los agentes se conocen y se descartan).
3. **Respuesta por rol**: el presentador da órdenes, el público pregunta, el
   agente se ignora.

Va en el audio de Rust de Apuntador (`audio.rs` → `segmenter.rs`). También le
sirve a Apuntador solo: no sigue el guion con preguntas del público ni con el
audio de un video. Código: unas 2 h la cancelación (riesgo: compilar la
librería C++ de WebRTC en Windows) y 2 a 3 h la huella de voz.

### R3 · Generar presentaciones desde archivos

1. Se sueltan archivos (PDF, DOCX, MD, PPTX) en Apuntador o en OpenWebUI.
2. Se indexan con EmbeddingGemma (embedder del VPS, tailnet).
3. El agente (Apolo u otro modelo en OpenWebUI) recupera lo relevante y pide a
   WeGraph las reglas que aplican (`get_doc` / relevancia por MCP en
   `mcp.wefaber.net`): estilo de marca, cuántas viñetas por diapositiva,
   errores conocidos.
4. Devuelve un **guion de Apuntador** con `claves:`, `diapo:` y `video:`, y lo
   carga con `POST /mazo` (R1).
5. Se revisa en el editor (E) y se acepta.

- **Si OpenWebUI ya indexa con EmbeddingGemma** (Knowledge): Apuntador no
  necesita RAG propio. Sube los archivos con la API de OpenWebUI y pide la
  generación. Alrededor de 1 h de código.
- **Si el embedder es un servicio suelto**: hace falta extraer texto, partir,
  indexar y guardar vectores. De 3 a 5 h más el deploy por el pipeline, y
  conviene que viva en el VPS (lo usan Apolo y Apuntador), no en la app.
- Las reglas de formato del guion se publican en WeGraph como regla del
  proyecto, así cualquier agente genera guiones válidos.

### R4 · Lenguaje corporal, en la PC

Corre en la WebView sobre el mismo cuadro de la vista previa que ya mira
`camera.ts`. El video no sale de la máquina.

- **MediaPipe Tasks Vision** (WASM, GPU de WebView2, CPU de respaldo): Pose,
  Face (blendshapes e iris) y Hand. A 10–15 cuadros por segundo. Los modelos
  se bajan una vez, como Parakeet.
- **Señales**, contra tu propia base (como `coach.ts`, no contra números
  fijos): mirada a cámara; postura (encorvado, hombros inclinados, balanceo);
  manos (visibles, abiertas, gestos que acompañan vs. tocarse la cara,
  movimiento repetitivo); brazos cruzados; expresión (sonrisa, cejas).
- **En vivo**: mismos avisos que la cámara (4 de los últimos 5 cuadros, uno
  por vez, sin repetir en 90 s), por la voz del coach.
- **Lo que querés transmitir**: cada sección ya tiene un tono (`energía`,
  `calma`, `firmeza`…, `llm.ts`). Se compara con lo que mostraron el cuerpo y
  la voz (prosodia de `prosody.rs`). Sale un puntaje por sección.
- **Después de la toma**: línea de tiempo por punto (voz + cuerpo + texto) y
  qué mejorar, en Notas de la toma (N).
- Riesgo: Parakeet en DirectML y MediaPipe en la GPU a la vez. Hay que medirlo
  en la PC lenta antes de prometer los 15 cuadros.
- Los umbrales se ajustan con tomas etiquetadas, no a ojo.

### R5 · Aprendizaje con MindVault, Apolo y WeGraph

- **MindVault** (tailnet): al cerrar la toma, un registro por toma con los
  números y las observaciones (`POST /memories`, tipo `evento`, tema
  `presentaciones`, `contexto.fuente = "apuntador"`), por outbox con
  `client_id` para no duplicar. Apolo lo lee para su modelo y sus
  predicciones.
- **WeGraph**: solo reglas generales ("máximo seis viñetas por diapositiva";
  errores que se repiten al presentar), por outbox que se aprueba a mano.
  Nunca métricas personales: lo que sube al grafo en la nube no se puede
  borrar.
- El circuito se cierra: WeGraph alimenta la generación (R3) y el coach (R4).

## Privacidad

| Dato | Dónde queda |
|---|---|
| Video y audio de la toma | solo la PC |
| Señales de cuerpo y voz (números) | PC → MindVault (tailnet) |
| Huella de voz (R2) | solo la PC |
| Texto transcripto | PC; al LLM configurado si está DeepSeek u OpenWebUI |
| Documentos para generar | OpenWebUI y su proveedor de LLM |
| Voz de Apolo | ElevenLabs o Cartesia (como hoy en MindVault) |
| Reglas generales | WeGraph, con aprobación |

## Preguntas abiertas

1. ¿Qué presentación es y cuándo? Fija hasta dónde llega "ahora".
2. ¿Los documentos ya están indexados en OpenWebUI (Knowledge) con
   EmbeddingGemma, o el embedder del VPS es un servicio aparte? Define si R3
   es 1 h o 5 h de código.
3. ¿OpenWebUI corre en el VPS hoy, y Apolo está cargado ahí como modelo?
4. ¿Se presenta siempre desde esta app (proyector conectado a la PC) o también
   hace falta mostrar las diapositivas en un navegador remoto?
