//! El iPhone como cámara. Un servidor chico en 127.0.0.1 sirve la página del
//! teléfono y hace de pasamanos entre el teléfono y la interfaz de la PC para
//! armar la conexión WebRTC (la imagen va directo de uno al otro, no pasa por
//! acá). Tailscale Serve lo publica con HTTPS solo dentro de la tailnet, que
//! es lo que Safari pide para dar la cámara.
//!
//! Si el teléfono no resuelve los nombres de la tailnet, hay un link temporal:
//! Tailscale Funnel en el puerto 8443, visible desde internet mientras el
//! iPhone está elegido como cámara. Por ahí pasan la página y el armado de la
//! conexión, los dos con el token; la imagen sigue yendo directo por la red.
//!
//! El protocolo (mensajes JSON por /ws) está en `src/lib/phone-protocol.ts`:
//! una app nativa de iOS puede hablarlo igual que la página.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

pub const PORT: u16 = 5190;
/// El puerto público de Funnel. El 443 queda para la tailnet.
const PUBLIC_PORT: u16 = 8443;
const TAILSCALE: &str = r"C:\Program Files\Tailscale\tailscale.exe";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Pc,
    Phone,
}

type Peer = (u64, UnboundedSender<String>);

#[derive(Default)]
struct Peers {
    pc: Option<Peer>,
    phone: Option<Peer>,
    next: u64,
}

impl Peers {
    fn slot(&mut self, role: Role) -> &mut Option<Peer> {
        match role {
            Role::Pc => &mut self.pc,
            Role::Phone => &mut self.phone,
        }
    }

    fn send(&self, role: Role, text: String) {
        let peer = match role {
            Role::Pc => &self.pc,
            Role::Phone => &self.phone,
        };
        if let Some((_, tx)) = peer {
            let _ = tx.send(text);
        }
    }
}

#[derive(Clone)]
struct Hub {
    token: Arc<str>,
    peers: Arc<Mutex<Peers>>,
}

/// Lo que la interfaz necesita para mostrar el QR.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub token: String,
    pub port: u16,
    /// https://pc.tailnet.ts.net/telefono?t=…, si Tailscale está andando.
    pub url: Option<String>,
    /// Si la dirección es el link temporal (internet) y no la tailnet.
    pub public: bool,
    pub error: Option<String>,
}

pub struct Phone {
    token: String,
    error: Arc<Mutex<Option<String>>>,
    public: AtomicBool,
}

impl Phone {
    /// Arranca el servidor en segundo plano. Si el puerto está ocupado, la
    /// app sigue igual y el error se ve en la vista previa.
    pub fn start() -> Self {
        let token = new_token();
        let error = Arc::new(Mutex::new(None));
        let hub = Hub { token: token.as_str().into(), peers: Arc::default() };
        let slot = error.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve(hub).await {
                log::error!("teléfono: {e}");
                if let Ok(mut s) = slot.lock() {
                    *s = Some(e);
                }
            }
        });
        Phone { token, error, public: AtomicBool::new(false) }
    }

    /// Prende o apaga el link temporal. Apagar no toca lo de la tailnet.
    pub fn set_public(&self, on: bool) -> Result<(), String> {
        let target = format!("http://127.0.0.1:{PORT}");
        let https = format!("--https={PUBLIC_PORT}");
        let args: Vec<&str> = if on { vec!["funnel", "--bg", &https, &target] } else { vec!["funnel", &https, "off"] };
        let out = tailscale(&args)?;
        // Apagar algo que ya estaba apagado no es un error.
        if !out.status.success() && on {
            let msg = String::from_utf8_lossy(&out.stderr);
            return Err(format!("Tailscale no abrió el link temporal: {}", msg.trim()));
        }
        self.public.store(on, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_public(&self) -> bool {
        self.public.load(Ordering::SeqCst)
    }

    pub fn info(&self) -> Info {
        let error = self.error.lock().ok().and_then(|e| e.clone());
        let public = self.is_public();
        let (url, dns_error) = match tailscale_host() {
            Ok(host) if public => (Some(format!("https://{host}:{PUBLIC_PORT}/telefono?t={}", self.token)), None),
            Ok(host) => (Some(format!("https://{host}/telefono?t={}", self.token)), None),
            Err(e) => (None, Some(e)),
        };
        Info { token: self.token.clone(), port: PORT, url, public, error: error.or(dns_error) }
    }
}

fn new_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::fill(&mut buf).is_err() {
        // Sin azar del sistema: algo que cambie en cada arranque.
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        buf.copy_from_slice(&nanos.to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn tailscale(args: &[&str]) -> Result<std::process::Output, String> {
    let exe = std::env::var("TAILSCALE_EXE").unwrap_or_else(|_| TAILSCALE.into());
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Sin ventana de consola que aparezca y desaparezca.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output().map_err(|e| format!("No encuentro Tailscale ({exe}): {e}"))
}

/// El nombre de esta PC en la tailnet, sin el punto final.
fn tailscale_host() -> Result<String, String> {
    let out = tailscale(&["status", "--json"])?;
    if !out.status.success() {
        return Err("Tailscale no está conectado".into());
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let name = json["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.');
    if name.is_empty() {
        return Err("Tailscale no tiene nombre para esta PC (¿MagicDNS apagado?)".into());
    }
    Ok(name.to_string())
}

fn router(hub: Hub) -> Router {
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/telefono") }))
        .route("/telefono", get(|| async { asset("index.html", "text/html; charset=utf-8") }))
        .route("/telefono/app.js", get(|| async { asset("app.js", "text/javascript; charset=utf-8") }))
        .route("/ws", get(socket))
        .with_state(hub)
}

async fn serve(hub: Hub) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|e| format!("No pude abrir el puerto {PORT}: {e}"))?;
    axum::serve(listener, router(hub)).await.map_err(|e| e.to_string())
}

/// En desarrollo se lee del disco (lo arma `bun run phone:build`); en la app
/// armada va adentro del ejecutable.
fn asset(name: &str, mime: &'static str) -> Response {
    #[cfg(debug_assertions)]
    let body = {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-phone").join(name);
        std::fs::read_to_string(&path).ok()
    };
    #[cfg(not(debug_assertions))]
    let body = match name {
        "index.html" => Some(include_str!("../../dist-phone/index.html").to_string()),
        "app.js" => Some(include_str!("../../dist-phone/app.js").to_string()),
        _ => None,
    };
    match body {
        Some(b) => ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-store")], b).into_response(),
        None => (StatusCode::NOT_FOUND, "Falta la página del teléfono: corré bun run phone:build").into_response(),
    }
}

#[derive(Deserialize)]
struct Join {
    role: Role,
    t: String,
}

async fn socket(ws: WebSocketUpgrade, Query(q): Query<Join>, State(hub): State<Hub>) -> Response {
    if q.t != *hub.token {
        return (StatusCode::FORBIDDEN, "Token inválido: volvé a escanear el QR").into_response();
    }
    ws.on_upgrade(move |socket| run(socket, q.role, hub))
}

fn peer_message(connected: bool) -> String {
    serde_json::json!({ "type": "peer", "connected": connected }).to_string()
}

async fn run(socket: WebSocket, role: Role, hub: Hub) {
    let other = if role == Role::Pc { Role::Phone } else { Role::Pc };
    let (tx, mut rx) = unbounded_channel::<String>();
    let id = {
        let Ok(mut peers) = hub.peers.lock() else { return };
        peers.next += 1;
        let id = peers.next;
        // Uno por lado: el que llega reemplaza al anterior.
        *peers.slot(role) = Some((id, tx.clone()));
        let other_here = peers.slot(other).is_some();
        let _ = tx.send(peer_message(other_here));
        peers.send(other, peer_message(true));
        id
    };
    // El único que manda por este canal es el lugar en `peers`: al
    // reemplazarlo, el canal se cierra y con él este socket.
    drop(tx);

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(peers) = hub.peers.lock() {
                    peers.send(other, text.to_string());
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if let Ok(mut peers) = hub.peers.lock() {
        let slot = peers.slot(role);
        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
            *slot = None;
            peers.send(other, peer_message(false));
        }
    }
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as Msg;

    async fn start(token: &str) -> u16 {
        let hub = Hub { token: token.into(), peers: Arc::default() };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router(hub)).await.unwrap() });
        port
    }

    async fn next_text<S>(ws: &mut S) -> serde_json::Value
    where
        S: futures_util::Stream<Item = Result<Msg, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await.unwrap().unwrap().unwrap();
        serde_json::from_str(msg.to_text().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn relays_between_pc_and_phone() {
        let port = start("abc").await;
        let url = |role: &str, t: &str| format!("ws://127.0.0.1:{port}/ws?role={role}&t={t}");

        assert!(connect_async(url("phone", "mal")).await.is_err(), "sin el token no entra");

        let (mut pc, _) = connect_async(url("pc", "abc")).await.unwrap();
        assert_eq!(next_text(&mut pc).await["connected"], false, "todavía no hay teléfono");

        let (mut phone, _) = connect_async(url("phone", "abc")).await.unwrap();
        assert_eq!(next_text(&mut phone).await["connected"], true, "la PC ya estaba");
        assert_eq!(next_text(&mut pc).await["connected"], true, "llegó el teléfono");

        phone.send(Msg::Text(r#"{"type":"offer","sdp":"x"}"#.into())).await.unwrap();
        assert_eq!(next_text(&mut pc).await["type"], "offer");
        pc.send(Msg::Text(r#"{"type":"answer","sdp":"y"}"#.into())).await.unwrap();
        assert_eq!(next_text(&mut phone).await["sdp"], "y");

        // Un teléfono nuevo reemplaza al anterior, que queda cerrado.
        let (mut again, _) = connect_async(url("phone", "abc")).await.unwrap();
        assert_eq!(next_text(&mut again).await["connected"], true);
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match phone.next().await {
                    None | Some(Err(_)) | Some(Ok(Msg::Close(_))) => break,
                    _ => {}
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "el teléfono viejo se cierra");

        drop(again);
        // La PC se entera de que no hay teléfono (puede llegar primero el aviso del nuevo).
        let mut gone = false;
        for _ in 0..3 {
            if next_text(&mut pc).await["connected"] == false {
                gone = true;
                break;
            }
        }
        assert!(gone, "la PC se entera de que se fue el teléfono");
    }

    /// Prende el link temporal, deja la URL impresa 20 s y lo apaga.
    /// `cargo test --lib public_link -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn public_link() {
        let hub = Hub { token: "prueba".into(), peers: Arc::default() };
        tokio::spawn(async move { serve(hub).await.unwrap() });
        let phone = Phone { token: "prueba".into(), error: Arc::default(), public: AtomicBool::new(false) };
        phone.set_public(true).unwrap();
        println!("abierto: {:?}", phone.info().url);
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        phone.set_public(false).unwrap();
        println!("cerrado: {:?}", phone.info().url);
    }

    /// Para probar la página a mano: sirve en el puerto de siempre con el token `prueba`.
    /// `cargo test --lib serve_for_manual_test -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn serve_for_manual_test() {
        serve(Hub { token: "prueba".into(), peers: Arc::default() }).await.unwrap();
    }
}
