//! Compartir el reconocimiento de esta PC con otras de la tailnet: una laptop
//! sin GPU manda el audio de cada frase y recibe el texto. Escucha solo en
//! 127.0.0.1; Tailscale Serve lo publica en el puerto 5191 únicamente dentro
//! de la tailnet (nunca por Funnel). Cada pedido lleva la clave de esta PC.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use crate::engine::{self, Accel, RemoteHealth, Slot, Transcript};
use crate::phone;

pub const PORT: u16 = 5191;
/// 60 s de audio a 16 kHz en 16 bits; una frase nunca llega a tanto.
const MAX_BODY: usize = 60 * 16_000 * 2;

#[derive(Clone)]
struct Ctx {
    key: String,
    slot: Slot,
    dir: PathBuf,
    accel: Accel,
    name: String,
}

#[derive(Default)]
pub struct Share {
    running: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub on: bool,
    pub url: Option<String>,
    pub key: String,
}

/// La clave de esta PC: se crea una vez y queda en la carpeta de configuración.
pub fn key(config: &Path) -> String {
    let path = config.join("compartir.clave");
    if let Ok(k) = std::fs::read_to_string(&path) {
        let k = k.trim().to_string();
        if k.len() >= 32 {
            return k;
        }
    }
    let mut buf = [0u8; 24];
    let _ = getrandom::fill(&mut buf);
    let k: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let _ = std::fs::create_dir_all(config);
    let _ = std::fs::write(&path, &k);
    k
}

fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/stt/health", get(health))
        .route("/stt", post(transcribe))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(ctx)
}

fn url() -> Option<String> {
    phone::tailscale_host().ok().map(|h| format!("https://{h}:{PORT}"))
}

impl Share {
    pub fn is_on(&self) -> bool {
        self.running.lock().is_ok_and(|r| r.is_some())
    }

    pub fn info(&self, config: &Path) -> ShareInfo {
        ShareInfo { on: self.is_on(), url: url(), key: key(config) }
    }

    pub fn start(&self, config: &Path, slot: Slot, dir: PathBuf, accel: Accel) -> Result<ShareInfo, String> {
        if self.is_on() {
            return Ok(self.info(config));
        }
        let name = phone::tailscale_host().map(|h| h.split('.').next().unwrap_or(&h).to_string()).unwrap_or_else(|_| "esta PC".into());
        let ctx = Ctx { key: key(config), slot, dir, accel, name };
        let router = router(ctx);
        let listener = std::net::TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| format!("No pude abrir el puerto {PORT}: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let handle = tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => {
                    if let Err(e) = axum::serve(l, router).await {
                        log::error!("compartir: {e}");
                    }
                }
                Err(e) => log::error!("compartir: {e}"),
            }
        });
        let https = format!("--https={PORT}");
        let target = format!("http://127.0.0.1:{PORT}");
        match phone::tailscale(&["serve", "--bg", &https, &target]) {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                handle.abort();
                return Err(format!("Tailscale no publicó el reconocimiento: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            Err(e) => {
                handle.abort();
                return Err(e);
            }
        }
        *self.running.lock().map_err(|e| e.to_string())? = Some(handle);
        Ok(self.info(config))
    }

    pub fn stop(&self) {
        let taken = self.running.lock().ok().and_then(|mut r| r.take());
        if let Some(handle) = taken {
            let https = format!("--https={PORT}");
            let _ = phone::tailscale(&["serve", &https, "off"]);
            handle.abort();
        }
    }
}

fn authorized(headers: &HeaderMap, key: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| constant_eq(given.as_bytes(), key.as_bytes()))
}

/// Comparar sin cortar en el primer byte distinto.
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn health(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &ctx.key) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(RemoteHealth { name: ctx.name.clone(), accel: Some(ctx.accel) }).into_response()
}

async fn transcribe(State(ctx): State<Ctx>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers, &ctx.key) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.len() % 2 != 0 || body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Audio PCM de 16 bits, 16 kHz, mono").into_response();
    }
    let result = tokio::task::spawn_blocking(move || {
        engine::ensure(&ctx.slot, &ctx.dir, ctx.accel)?;
        engine::transcribe_local(&ctx.slot, &engine::from_pcm16(&body))
    })
    .await;
    match result {
        Ok(Ok(text)) => Json(Transcript { text }).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_key() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "abc"));
        h.insert(header::AUTHORIZATION, "Bearer abd".parse().unwrap());
        assert!(!authorized(&h, "abc"));
        h.insert(header::AUTHORIZATION, "Bearer abc".parse().unwrap());
        assert!(authorized(&h, "abc"));
    }

    /// Arranca el servidor en un puerto libre y le habla como lo hace una laptop.
    async fn serve_on_free_port(ctx: Ctx) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router(ctx)).await.unwrap() });
        format!("http://127.0.0.1:{port}")
    }

    fn ctx(dir: PathBuf) -> Ctx {
        Ctx { key: "clave-de-prueba".into(), slot: Slot::default(), dir, accel: Accel::Cpu, name: "prueba".into() }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_a_wrong_key() {
        let base = serve_on_free_port(ctx(PathBuf::from("no-hay-modelo"))).await;
        let (bad, good) = tokio::task::spawn_blocking(move || {
            let bad = engine::Remote::new(&base, "otra").unwrap().health();
            let good = engine::Remote::new(&base, "clave-de-prueba").unwrap().health();
            (bad, good)
        })
        .await
        .unwrap();
        assert_eq!(bad.err().as_deref(), Some("La otra PC no aceptó la clave"));
        assert_eq!(good.unwrap().name, "prueba");
    }

    /// Con el modelo real: `cargo test --release --lib real_share -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_share_round_trip() {
        let dir = std::env::var("APUNTADOR_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("APPDATA").unwrap()).join("net.wefaber.apuntador").join("models").join("parakeet-tdt-0.6b-v3-int8")
        });
        let base = serve_on_free_port(ctx(dir)).await;
        let text = tokio::task::spawn_blocking(move || {
            let clip = engine::from_pcm16(include_bytes!("../assets/bench-es.pcm"));
            let remote = engine::remote(&engine::EngineConfig {
                mode: engine::Mode::Remota,
                remote_url: Some(base),
                remote_key: Some("clave-de-prueba".into()),
                ..Default::default()
            })
            .unwrap();
            println!("motor: {}", remote.label());
            remote.transcribe(&clip).unwrap()
        })
        .await
        .unwrap();
        println!("dice: {text}");
        assert!(text.to_lowercase().contains("entrevista"));
    }

    #[test]
    fn keeps_the_same_key() {
        let dir = std::env::temp_dir().join(format!("apuntador-clave-{}", std::process::id()));
        let a = key(&dir);
        assert_eq!(a.len(), 48);
        assert_eq!(key(&dir), a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
