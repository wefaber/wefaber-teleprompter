//! La ventana del público: lo que se ve en el proyector o la segunda pantalla.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "audiencia";

/// Abre la ventana del público a pantalla completa en otro monitor. Con un solo
/// monitor, en una ventana común, para ensayar. Es async: en Windows, crear una
/// ventana desde un comando síncrono traba la app.
#[tauri::command]
pub async fn audience_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return w.show().map_err(|e| e.to_string());
    }
    let main = app.get_webview_window("main").ok_or("No encuentro la ventana principal")?;
    let here = main.current_monitor().ok().flatten();
    let other = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| here.as_ref().is_none_or(|h| m.position() != h.position()));
    // Los mismos argumentos que la principal: WebView2 no abre dos ventanas
    // con entornos distintos.
    let args = app
        .config()
        .app
        .windows
        .first()
        .and_then(|w| w.additional_browser_args.clone())
        .unwrap_or_default();
    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#audiencia".into()))
        .title("Apuntador · Público")
        .focused(false)
        .additional_browser_args(&args);
    let builder = match &other {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            builder.position(p.x as f64 / scale, p.y as f64 / scale).inner_size(1280.0, 720.0)
        }
        None => builder.inner_size(960.0, 540.0),
    };
    let window = builder.build().map_err(|e| format!("No pude abrir la ventana del público: {e}"))?;
    if other.is_some() {
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn audience_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) => w.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
