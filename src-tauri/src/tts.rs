//! La voz del coach. Por ahora un solo proveedor en la PC: las voces neurales
//! de Edge ("Leer en voz alta"), las mismas que usa el navegador. No es una API
//! pública: si Microsoft la cambia, la interfaz cae a las voces de Windows.
//! Otro proveedor (Azure, ElevenLabs…) entra como otra función que devuelve MP3.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const ENDPOINT: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const TIMEOUT: Duration = Duration::from_secs(10);
/// Segundos entre 1601 (la época de Windows) y 1970.
const WIN_EPOCH_OFFSET: u64 = 11_644_473_600;

/// El token que pide el servicio: SHA-256 de la hora redondeada a 5 minutos
/// (en unidades de 100 ns desde 1601) pegada al token del cliente.
fn sec_ms_gec(unix: u64) -> String {
    let secs = unix + WIN_EPOCH_OFFSET;
    let ticks = (secs - secs % 300) as u128 * 10_000_000;
    let digest = Sha256::digest(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    digest.iter().map(|b| format!("{b:02X}")).collect()
}

fn hex_id() -> String {
    let mut buf = [0u8; 16];
    let _ = getrandom::fill(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// "Thu Oct 01 2026 12:00:00 GMT+0000 (Coordinated Universal Time)", como lo
/// manda el navegador.
fn js_date(unix: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let days = (unix / 86_400) as i64;
    let rem = unix % 86_400;
    // Días desde 1970 a fecha civil (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{} {} {:02} {} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[days.rem_euclid(7) as usize],
        MONTHS[(month - 1) as usize],
        day,
        year,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Nombre de voz como "es-AR-TomasNeural": nada que pueda romper el SSML.
fn valid_voice(voice: &str) -> bool {
    !voice.is_empty() && voice.len() < 64 && voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn ssml(text: &str, voice: &str, rate: i32) -> String {
    let lang = voice.splitn(3, '-').take(2).collect::<Vec<_>>().join("-");
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>\
         <voice name='{voice}'><prosody pitch='+0Hz' rate='{rate:+}%' volume='+0%'>{}</prosody></voice></speak>",
        escape(text)
    )
}

/// Separa el encabezado del audio en un mensaje binario: dos bytes con el
/// largo del encabezado y después el MP3.
fn audio_part(frame: &[u8]) -> Option<&[u8]> {
    if frame.len() < 2 {
        return None;
    }
    let len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
    let header = frame.get(2..2 + len)?;
    if !String::from_utf8_lossy(header).contains("Path:audio") {
        return None;
    }
    frame.get(2 + len..)
}

/// MP3 de `text` dicho por `voice`. `rate` en por ciento (+10 = 10 % más rápido).
pub async fn edge(text: &str, voice: &str, rate: i32) -> Result<Vec<u8>, String> {
    if !valid_voice(voice) {
        return Err(format!("Voz inválida: {voice}"));
    }
    let text = text.trim();
    if text.is_empty() || text.len() > 2_000 {
        return Err("Texto vacío o demasiado largo".into());
    }
    tokio::time::timeout(TIMEOUT, synthesize(text, voice, rate.clamp(-50, 100)))
        .await
        .map_err(|_| "La voz de Edge no respondió a tiempo".to_string())?
}

async fn synthesize(text: &str, voice: &str, rate: i32) -> Result<Vec<u8>, String> {
    let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let url = format!(
        "{ENDPOINT}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL_VERSION}&ConnectionId={}",
        sec_ms_gec(unix),
        hex_id()
    );
    let major = CHROMIUM_FULL_VERSION.split('.').next().unwrap_or("143");
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = req.headers_mut();
    let mut put = |k: &'static str, v: String| {
        if let Ok(v) = HeaderValue::from_str(&v) {
            headers.insert(k, v);
        }
    };
    put("Pragma", "no-cache".into());
    put("Cache-Control", "no-cache".into());
    put("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".into());
    put(
        "User-Agent",
        format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"),
    );
    put("Accept-Language", "en-US,en;q=0.9".into());
    put("Cookie", format!("muid={};", hex_id().to_uppercase()));

    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("No pude conectar con la voz de Edge: {e}"))?;

    let date = js_date(unix);
    let config = format!(
        "X-Timestamp:{date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"{FORMAT}\"}}}}}}}}\r\n"
    );
    ws.send(Message::Text(config.into())).await.map_err(|e| e.to_string())?;
    let request = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{date}Z\r\nPath:ssml\r\n\r\n{}",
        hex_id(),
        ssml(text, voice, rate)
    );
    ws.send(Message::Text(request.into())).await.map_err(|e| e.to_string())?;

    let mut mp3 = Vec::new();
    while let Some(msg) = ws.next().await {
        match msg.map_err(|e| e.to_string())? {
            Message::Binary(frame) => {
                if let Some(audio) = audio_part(&frame) {
                    mp3.extend_from_slice(audio);
                }
            }
            Message::Text(t) if t.contains("Path:turn.end") => break,
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    if mp3.is_empty() {
        return Err("La voz de Edge no devolvió audio".into());
    }
    Ok(mp3)
}

/// La salida de audio predeterminada de Windows, para saber si hay auriculares.
pub fn default_output() -> Option<String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    cpal::default_host().default_output_device()?.name().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_changes_every_five_minutes() {
        let t = 1_790_000_100; // múltiplo de 300 más 100
        assert_eq!(sec_ms_gec(t), sec_ms_gec(t + 150));
        assert_ne!(sec_ms_gec(t), sec_ms_gec(t + 300));
        assert_eq!(sec_ms_gec(t).len(), 64);
    }

    #[test]
    fn dates_like_the_browser() {
        assert_eq!(js_date(0), "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(js_date(1_790_812_800), "Thu Oct 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)");
    }

    #[test]
    fn ssml_is_escaped_and_voices_checked() {
        let s = ssml("a < b & 'c'", "es-AR-TomasNeural", 10);
        assert!(s.contains("xml:lang='es-AR'"));
        assert!(s.contains("rate='+10%'"));
        assert!(s.contains("a &lt; b &amp; &apos;c&apos;"));
        assert!(valid_voice("es-AR-ElenaNeural"));
        assert!(!valid_voice("x' onload='y"));
    }

    #[test]
    fn splits_audio_frames() {
        let header = b"Path:audio\r\n";
        let mut frame = (header.len() as u16).to_be_bytes().to_vec();
        frame.extend_from_slice(header);
        frame.extend_from_slice(&[1, 2, 3]);
        assert_eq!(audio_part(&frame), Some(&[1u8, 2, 3][..]));
        assert_eq!(audio_part(&[0, 5, b'x']), None);
    }

    /// Rehace el audio de la medición (`assets/bench-es.pcm`):
    /// `cargo test --lib make_bench_clip -- --ignored`, y después
    /// `ffmpeg -i target/bench-es.mp3 -ac 1 -ar 16000 -f s16le assets/bench-es.pcm`.
    #[tokio::test]
    #[ignore]
    async fn make_bench_clip() {
        let text = "Hoy les quiero mostrar cómo preparar una entrevista de trabajo con inteligencia artificial, paso a paso y sin perder tiempo.";
        let mp3 = edge(text, "es-AR-TomasNeural", 0).await.unwrap();
        std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/target/bench-es.mp3"), mp3).unwrap();
    }

    /// `cargo test --lib real_output -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_output() {
        println!("salida: {:?}", default_output());
    }

    /// Pega al servicio real. `cargo test --lib edge_speaks -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn edge_speaks() {
        let mp3 = edge("Más lento.", "es-AR-TomasNeural", 10).await.unwrap();
        println!("{} bytes de MP3", mp3.len());
        assert!(mp3.len() > 1_000);
    }
}
