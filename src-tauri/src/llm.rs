//! DeepSeek, para lo que no se resuelve con palabras clave. La clave vive en
//! el entorno (`DEEPSEEK_API_KEY`) y nunca pasa a la interfaz: la interfaz
//! arma el pedido y esto lo manda.

use serde::Serialize;
use std::time::Duration;

const URL: &str = "https://api.deepseek.com/chat/completions";
/// Sin razonamiento: responde en menos de un segundo, que es lo que importa
/// mientras se graba.
const MODEL: &str = "deepseek-flash";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub model: &'static str,
}

fn key() -> Option<String> {
    std::env::var("DEEPSEEK_API_KEY").ok().filter(|k| !k.trim().is_empty())
}

pub fn status() -> Status {
    Status { available: key().is_some(), model: MODEL }
}

/// Devuelve el contenido (JSON en texto) de la respuesta.
pub fn json(system: &str, user: &str, max_tokens: u32) -> Result<String, String> {
    let key = key().ok_or("Falta DEEPSEEK_API_KEY en el entorno")?;
    let body = serde_json::json!({
        "model": MODEL,
        "thinking": { "type": "disabled" },
        "response_format": { "type": "json_object" },
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|e| format!("DeepSeek no respondió: {e}"))?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = value["error"]["message"].as_str().unwrap_or("sin detalle");
        return Err(format!("DeepSeek respondió {status}: {msg}"));
    }
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "DeepSeek devolvió una respuesta vacía".into())
}
