# Apuntador

Teleprompter por puntos para grabar hablando a tu manera. No marca palabra por
palabra: muestra el punto actual en grande, tacha las viñetas a medida que las
nombrás y pasa al siguiente cuando empezás a hablar de él, aunque lo digas con
otras palabras o te saltees algo.

Mientras tanto, la pantalla entera funciona como luz de relleno, como
whitescreen: blanco, frío, cálido o cualquier color, con brillo regulable, y un
modo "solo luz" que esconde el texto.

El reconocimiento de voz corre en la PC con **Parakeet TDT 0.6B v3** (ONNX
int8, vía [`transcribe-rs`](https://github.com/cjpais/transcribe-rs)), con la
GPU o NPU si hay. El audio no sale de la máquina y anda sin internet una vez
bajado el modelo. Una PC que no da la velocidad puede usar otra de la tailnet o
xAI (ver [Motores de voz](#motores-de-voz)).

## Estructura

| Carpeta | Qué hace |
|---|---|
| `src/` | Interfaz: React 19, Vite, TailwindCSS v4. |
| `src/lib/match.ts` | El seguimiento: claves por punto, ventana con decaimiento, saltos. |
| `src/lib/recorder.ts` | Grabar la toma: formato, micrófono sin procesar, pedazos a disco. |
| `src-tauri/src/rec.rs` | Escribe la toma en `Videos\Apuntador` a medida que llega. |
| `src/lib/camera.ts` | Qué se mira de la imagen para los consejos de cámara. |
| `src/lib/library.ts` | Los guiones guardados y cuál se usa. |
| `src/lib/voice.ts` | La voz del coach: proveedores, auriculares y cuándo hablar. |
| `src-tauri/src/tts.rs` | Voces neurales de Edge, a MP3. |
| `src-tauri/src/phone.rs` | Servidor local del iPhone: sirve su página, pasa los mensajes de WebRTC y recibe la toma. |
| `src-tauri/src/take.rs` | Escribe en orden los pedazos de la toma que graba el iPhone. |
| `src/lib/phone-take.ts` | El lado teléfono de esa toma: formato y subida con reintentos. |
| `src/lib/phone-protocol.ts` | Los mensajes entre la PC y el teléfono (una app nativa habla lo mismo). |
| `src/lib/phone-link.ts` | El lado PC del iPhone: contesta la oferta y entrega el video. |
| `phone/` | La página que abre el iPhone (`bun run phone:build` la arma en `dist-phone/`). |
| `src/lib/script.ts` | El formato del guion. |
| `src/lib/default-script.md` | Guion de ejemplo (JobIt y LearnIt). |
| `src-tauri/src/audio.rs` | Micrófono con cpal, pasado a 16 kHz mono. |
| `src-tauri/src/segmenter.rs` | Corta en frases por energía y pide parciales mientras hablás. |
| `src-tauri/src/stt.rs` | Hilo de transcripción y eventos a la interfaz. |
| `src-tauri/src/model.rs` | Dónde vive el modelo y su descarga. |
| `src-tauri/src/engine.rs` | Motores de voz: hardware, medición, acelerador, otra PC, xAI y la elección automática. |
| `src-tauri/src/share.rs` | Compartir el reconocimiento de esta PC con la tailnet (puerto 5191, con clave). |
| `src/lib/engine.ts` | El lado interfaz de los motores y los términos del guion para xAI. |
| `src-tauri/assets/bench-es.pcm` | 7 s de voz para medir la PC (16 kHz mono s16le). |

## Requisitos (Windows)

- Bun
- Rust (toolchain MSVC)
- Visual Studio 2022 Build Tools con "Desarrollo para el escritorio con C++"
- WebView2 (ya viene con Windows 11)

## Uso

```bash
bun install
bun run tauri dev
```

La primera compilación tarda unos minutos. Al abrir, **Ajustes → Voz → Bajar
el modelo** (unos 670 MB, a `%APPDATA%\net.wefaber.apuntador\models`). Si ya lo
tenés bajado, `APUNTADOR_MODEL_DIR` apunta a esa carpeta.

Instalador:

```bash
bun run tauri build
```

Solo la interfaz, en Chrome, con el reconocimiento del navegador (manda el audio
a Google; sirve para probar el diseño):

```bash
bun run dev
```

En desarrollo, `__decir("texto")` en la consola hace de micrófono.

## El guion

```
# Sección
## Punto
claves: mcp, agente, eme ce pe
- Viñeta
nota: recordatorio que se ve en naranja
```

- Las **claves** son lo que vas a decir de verdad, separadas por comas. Pueden
  ser frases.
- El título, las viñetas y el nombre de la sección también cuentan, con menos
  peso. Una palabra que está en muchos puntos pesa poco.
- Una sigla que se transcribe rara se suma como suena: `eme ce pe`.

**Varios guiones** (`src/lib/library.ts`): en el editor (E) se eligen, se
crean, se duplican, se renombran y se borran; "Abrir .md" suma uno nuevo. Todo
se aplica al guardar: cerrar sin guardar no toca nada. Arriba del índice (O)
hay un selector para cambiar de guion sin abrir el editor. Cambiar de guion es
otra toma: vuelve al primer punto con el reloj y las notas en cero. El guion
suelto de antes queda como el primero.

## Cómo decide

- Lo recién dicho pesa entero y se apaga en unos segundos, así el cambio de
  tema se nota aunque antes hayas hablado mucho del punto anterior.
- Mira el siguiente, los dos de después y el anterior. Más lejos, solo hacia
  adelante y con evidencia clara (varias claves a la vez). Hacia atrás nunca más
  de un punto: volver a nombrar algo ya dicho es casi siempre una mención.
- **Solo el siguiente de la misma sección pasa con una frase.** Saltearse
  puntos, volver uno o cambiar de sección con el punto a medias pide **dos
  frases cerradas seguidas** (en menos de 12 s) que apunten al mismo lugar, y
  la segunda tiene que hablar de ese punto por sí sola: una mención suelta no
  se confirma con lo que quedó en la ventana.
- Con todas las viñetas dichas, pasar al siguiente (aunque sea otra sección)
  pide menos y va con una frase.
- Espera 2,5 s en cada punto antes de volver a saltar.
- Abajo del punto actual se ve el que sigue, con sus viñetas.
- Sensibilidad baja, media o alta en Ajustes; "Avanzar solo" apagado deja solo
  el tachado y avanzás a mano.

## Motores de voz

Ajustes → Voz → **Dónde se reconoce**:

- **Automático** (por defecto): la primera vez que escuchás mide esta PC con
  7 s de voz grabada (`src-tauri/assets/bench-es.pcm`), con cada acelerador
  que tenga: **DirectML** (cualquier GPU o NPU en Windows: NVIDIA, AMD, Intel,
  Copilot+) y **CPU**. Se queda con el más rápido. Si ni ese llega a ir en
  vivo (más de medio segundo por segundo de audio), usa la otra PC; si no hay,
  xAI; si tampoco, sigue en esta PC con un aviso. La medición se guarda en
  `%APPDATA%
et.wefaber.apuntadormotor.json` y se repite sola si cambia el
  hardware; "Medir de nuevo" la fuerza.
- **Esta PC**: siempre local. Se puede forzar el acelerador.
- **Otra PC**: una PC de la tailnet con el modelo activa **Compartir esta PC**.
  Eso levanta un servidor en `127.0.0.1:5191` y lo publica con
  `tailscale serve` solo dentro de la tailnet (no Funnel), pidiendo una clave
  que queda en `compartir.clave`. En la PC lenta se pega la dirección
  (`https://pc.tailnet.ts.net:5191`) y la clave, y "Probar" confirma. Cada
  frase viaja como PCM 16 bits y vuelve el texto. Un VPS de la tailnet sirve
  igual. Al cerrar la app se apaga.
- **xAI**: `POST https://api.x.ai/v1/stt`, USD 0,10 la hora. La clave sale de
  `XAI_API_KEY` en el entorno y solo la lee Rust; la interfaz nunca la ve.
  Solo manda frases cerradas (sin parciales, para no pagar el mismo audio dos
  veces), así que el tachado llega al terminar cada frase. Las claves y
  títulos del guion van como `keyterm` para que acierte nombres y siglas.

Abajo, mientras escucha, se ve qué motor quedó ("Esta PC · DirectML",
"Otra PC · one", "xAI"). Un error de red se muestra unos segundos y la frase se
pierde, la escucha sigue.

## Coach

**En la PC, sin conexión** (`src-tauri/src/prosody.rs`): de cada frase se mide
cuánto duró la voz, el tono (F0 con YIN) y cuánto se movió, y el volumen.
`src/lib/coach.ts` lo compara con **tu propia base** (las primeras seis frases
con tono claro), no con un número fijo, y avisa de a un consejo por vez, sin
repetir el mismo tipo en 45 s:

- más de 190 o menos de 105 palabras por minuto;
- tono 2,5 semitonos por encima de tu base;
- voz plana (el tono se mueve menos de 1,3 semitonos);
- volumen 6 dB por debajo de tu base.

**Con DeepSeek** (`src/lib/llm.ts`, opcional, `DEEPSEEK_API_KEY` en el
entorno). Se manda el guion y el texto transcripto, nunca el audio.

- **Tono por sección**: una vez por guion (se guarda por contenido). Se ve como
  etiqueta arriba ("energía", "calma", "firmeza"…) y como consejo al entrar a
  la sección.
- **Seguir por el sentido**: cada diez palabras le pregunta de qué punto estás
  hablando aunque no uses ninguna clave. Con confianza de 0,7 o más vota como
  una frase más (mismas reglas: lo que no es el siguiente espera confirmación,
  y nunca más de un punto atrás ni tres adelante) y tacha las viñetas que
  dijiste con otras palabras. Si mientras tanto te
  moviste por claves o a mano, gana eso. Tres frases seguidas fuera de tema
  traen un aviso.
- **Devolución por sección**: al cerrar una sección, una observación y un
  consejo para la próxima toma, en el panel **Notas de la toma** (N).

Usa `deepseek-flash` sin razonamiento: responde en menos de un segundo.

**Voz del coach** (`src/lib/voice.ts`, `src-tauri/src/tts.rs`): los consejos,
en dos o tres palabras ("Más lento", "Fuera de foco", "Volvé a: …"), dichos
por los auriculares, así no hace falta leerlos mientras grabás.

- **Con auriculares** (por defecto): habla solo si la salida de Windows parece
  de auriculares (AirPods, Buds, "Headphones", el QuadCast, que solo tiene
  salida de auriculares). Con parlantes el micrófono la levantaría y quedaría
  en la toma. **Siempre** habla por lo que haya.
- Espera una pausa tuya (medio segundo de silencio). Si en 7 s no la hay, el
  consejo se descarta; si llega otro, se dice el último.
- Voces neurales de Edge (Tomás o Elena de Argentina, y otras): el mismo
  servicio que "Leer en voz alta" del navegador. No es una API pública, puede
  cambiar; si falla, habla la voz de Windows. Cada frase se pide una vez.
- Otro proveedor (Azure, ElevenLabs…) es otro prefijo en `VOICES` y otra
  función en `tts.rs` que devuelva MP3.
- Aunque el texto esté oculto (solo luz), la voz sigue avisando.

## Cámara

**Ajustes → Cámara → Vista previa** (o C). Con DroidCam, elegí *DroidCam
Source* en la lista. La primera vez Windows pide permiso para la cámara.

- **Resolución de captura**: DroidCam anuncia varios tamaños pero manda uno
  solo, el que tenga su cliente; si se le pide otro, la imagen sale verde. En
  *Automática* prueba 1920x1080, 1280x720, 640x480… hasta que llega imagen de
  verdad y se acuerda del que anduvo. También se puede fijar a mano.
- Formato 16:9 (el de DroidCam), 9:16, 4:5 o 1:1: se ve el recorte que va a
  quedar. En 9:16 las guías marcan lo que tapan el nombre, la descripción y los
  botones de un reel.
- El texto se corre para no quedar debajo de la vista previa.
- Girar (si DroidCam manda la imagen acostada), espejo, esquina y tamaño.
- **Consejos de cámara**: cada 1,5 s mira un cuadro chico del recorte, en la PC.
  Avisa solo si el problema aparece en 4 de los últimos 5 cuadros, de a uno por
  vez y sin repetir el mismo en 90 s:
  - sin imagen (DroidCam desconectado, o la imagen se puso verde porque
    cambió la resolución del cliente);
  - falta luz en la cara (si el brillo de la pantalla no está al máximo, lo dice);
  - partes quemadas;
  - contraluz (el borde mucho más claro que el centro);
  - imagen lavada, con los negros levantados: lente sucia;
  - imagen blanda: foco o lente;
  - fondo que tira a naranja o a azul (se mide en el fondo, no en la cara).

## iPhone como cámara

Sin app ni cuenta de Apple: el iPhone abre una página y manda la imagen a la
PC por WebRTC, directo entre los dos (el servidor de la app solo pasa los
mensajes para armar la conexión).

**Una vez**, en la PC, publicar el servidor del teléfono con HTTPS dentro de la
tailnet (Safari no da la cámara sin HTTPS):

```bash
"/c/Program Files/Tailscale/tailscale.exe" serve --bg --https=443 http://127.0.0.1:5190
```

Queda solo para los equipos de la tailnet, no sale a internet.

**Link temporal** (por defecto, Ajustes → Cámara → *Cómo llega el teléfono*):
si el iPhone no resuelve los nombres de la tailnet, la app abre Tailscale
Funnel en `https://<pc>.ts.net:8443` mientras el iPhone está elegido como
cámara, y lo cierra al cambiar de cámara o cerrar la app. El 443 sigue solo
para la tailnet. Por internet pasan la página y el armado de la conexión, los
dos con el token del QR (cambia en cada arranque); la imagen va directo por el
WiFi, así que el teléfono tiene que estar en la misma red que la PC. Pide
Funnel habilitado en la tailnet (`funnel` en los atributos del equipo).

**Cada vez**: Ajustes → Cámara → *iPhone, por la red (QR)*. La vista previa
muestra un QR; escanearlo con la cámara del iPhone (con Tailscale prendido en
el teléfono) y tocar **Conectar la cámara**.

- **Trasera** (por defecto): mejor lente y mejor con poca luz. El guion sigue
  en la PC.
- **Frontal, con guion**: el punto actual, sus viñetas y el que sigue se ven en
  el teléfono, pegados al lente. Se cambia en Ajustes o con el botón del
  teléfono; los dos quedan de acuerdo.
  - El fondo es el color de la luz elegida en la PC (Ajustes → Luz): la
    pantalla suma luz de frente. La web no puede subir el brillo del iPhone:
    ponelo al máximo a mano.
  - Arriba a la derecha, el tiempo de la toma (el mismo reloj de la PC) y, si
    está grabando, REC con su tiempo.
- La vista previa va a 1280 px y hasta 6 Mb/s; la cámara abre a la mayor
  resolución que dé (4K en la trasera).
- La pantalla del teléfono no se apaga mientras la página está abierta.
- Si la conexión se cae, la PC le pide al teléfono otra oferta cada 3 s.
- La app arranca WebView2 con `WebRtcHideLocalIpsWithMdns` apagado
  (`tauri.conf.json`): si no, la PC anuncia nombres `.local` que el iPhone no
  resuelve y la imagen no pasa.
- Cada arranque de la app cambia el token del QR.

Para probar la página sin la app, esto sirve en el puerto 5190 con el token
`prueba`:

```bash
cd src-tauri && cargo test --lib serve_for_manual_test -- --ignored
```

## Grabar

**G** (o el botón rojo) graba el video de la vista previa y el micrófono en la
PC, en `Videos\Apuntador\toma-AAAA-MM-DD_HH-MM-SS.mkv` (o donde diga
`APUNTADOR_VIDEO_DIR`). Cada segundo lo grabado va a disco (en base64: así
llega igual por los dos caminos del IPC de Tauri): si algo se cuelga,
queda hasta ahí.

- **Video**: el cuadro completo que manda la cámara, sin el recorte ni el
  espejo de la vista previa. H.264 a 20, 40 u 80 Mb/s.
- **Audio**: el micrófono elegido en Ajustes → Grabación, tal cual: sin
  cancelación de eco, sin supresión de ruido y sin ganancia automática.
- **MKV** (por defecto): audio PCM sin compresión. Si el editor no abre MKV,
  pasarlo a MOV sin recomprimir:
  `ffmpeg -i toma.mkv -c copy toma.mov`. **MP4**: audio AAC, listo para subir.
- Si la cámara se cierra o cambia a mitad de la toma, se guarda lo grabado.
- Con el iPhone, ver abajo: además de la vista previa, el teléfono graba a
  resolución completa.

### Con el iPhone

Con *Grabar también en el iPhone* (Ajustes → Cámara, prendido por defecto),
**G** graba dos archivos con la misma hora en el nombre:

- `toma-….mkv`: la vista previa (1280 px) con el micrófono de la PC, como
  siempre. Sirve de respaldo y trae el audio bueno.
- `toma-…-iphone.mp4`: la cámara del iPhone tal cual la abre (4K en la
  trasera), con el micrófono del iPhone, al bitrate de Ajustes → Grabación.

El teléfono graba con MediaRecorder y manda un pedazo por segundo a la PC
(`POST /rec` al mismo servidor, con el token), que lo escribe a disco en
orden (`src-tauri/src/take.rs`). Los pedazos van numerados: un reintento no se
escribe dos veces y si falta uno la PC lo dice. Al terminar la toma, la PC
espera a que llegue lo que falta; abajo se ve cuántos segundos quedan.

- Prueba los formatos en orden (MP4 H.264, después WebM) y se queda con el
  primero que de verdad produce video: algunos navegadores dicen que soportan
  MP4 y el codificador no arranca.
- Mientras graba no se puede cambiar de cámara.
- El permiso del micrófono del iPhone se pide al tocar *Conectar la cámara*.
- **Con el link temporal la toma sube por internet** (Funnel): depende de la
  subida de tu conexión. Con la tailnet va directo y es mucho más rápido.
- Si se bloquea la pantalla, Safari corta la cámara: queda lo que llegó y la
  PC avisa. Desactivá el bloqueo automático.
- Si la PC cierra la toma (o se reinició), el teléfono deja de grabar.

Para probarlo sin la app: `cargo test --lib take_for_manual_test -- --ignored
--nocapture` abre la toma `prueba1` en el puerto 5190 (token `prueba`) por
3 minutos.

## Mirar a cámara

Con el teléfono arriba del monitor y el texto en la pantalla, la mirada queda
unos grados por debajo del lente y se nota. Dos formas de achicarlo:

1. **Texto bajo la cámara** (Ajustes → Texto → Posición → *Bajo la cámara*):
   una columna angosta pegada arriba, centrada donde está el teléfono (la marca
   naranja del borde tiene que quedar justo debajo). Sentarse más lejos y
   agrandar el texto (+) achica el ángulo: con el texto a 8 cm del lente y a
   1 m de distancia son unos 4,5°, que casi no se nota.
2. **iPhone con la frontal** (ver *iPhone como cámara*): el guion va en el
   mismo teléfono, a centímetros del lente.
3. **Teleprompter de vidrio** (beam splitter) delante del teléfono: la única
   forma de mirar exactamente al lente. Pide texto espejado.

## Atajos

| Tecla | Acción |
|---|---|
| → Espacio Av Pág | Siguiente (un clicker de presentación manda Av Pág) |
| ← Re Pág | Anterior |
| M | Escuchar / pausar |
| A | Avanzar solo sí / no |
| L | Solo luz |
| O | Índice |
| E | Editar el guion (Ctrl+S guarda) |
| N | Notas de la toma |
| S | Ajustes |
| T | Mostrar lo que escucha |
| + − | Tamaño del texto |
| F | Pantalla completa |
| C | Vista previa de la cámara |
| G | Grabar / terminar la toma |
| R | Reiniciar reloj, base de voz y notas |

## Actualizaciones

La app instalada se actualiza sola desde Ajustes → Actualizaciones: busca al
abrir ese panel, baja el instalador firmado y reinicia (`tauri-plugin-updater`,
que lee `latest.json` de la última Release de GitHub).

Publicar una versión:

1. Subir la versión (nunca reusar un tag: las releases son inmutables) en `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` y
   `package.json`.
2. Mergear a `main` y crear el tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` arma el instalador, lo firma y publica la
   Release con `latest.json`. Falla si el tag no coincide con `tauri.conf.json`.

La clave de firma privada vive en el secreto `TAURI_SIGNING_PRIVATE_KEY` del
repo (y en `~/.tauri/apuntador.key`, fuera del repo); la pública está en
`tauri.conf.json`. Si se pierde la privada, las apps instaladas no pueden
actualizarse: hay que reinstalar a mano con una pública nueva.

## Tests

```bash
bun test
cd src-tauri && cargo test --lib
```
