mod audio;
mod engine;
mod llm;
mod model;
mod phone;
mod prosody;
mod rec;
mod segmenter;
mod share;
mod stt;
mod take;
mod tts;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct Downloading(AtomicBool);

#[tauri::command]
fn model_info(app: AppHandle) -> Result<model::ModelInfo, String> {
    model::info(&app)
}

/// Arranca la descarga en otro hilo; el resultado llega por
/// `model://done` o `model://error`.
#[tauri::command]
fn model_download(app: AppHandle, busy: State<'_, Downloading>) -> Result<(), String> {
    if busy.0.swap(true, Ordering::SeqCst) {
        return Err("Ya se está bajando".into());
    }
    std::thread::spawn(move || {
        let result = model::download(&app);
        let busy = tauri::Manager::state::<Downloading>(&app);
        busy.0.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                let _ = app.emit("model://done", model::info(&app).ok());
            }
            Err(e) => {
                let _ = app.emit("model://error", e);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn list_inputs() -> Vec<String> {
    audio::list_inputs()
}

#[tauri::command(async)]
fn stt_start(app: AppHandle, stt: State<'_, stt::Stt>, device: Option<String>, engine: Option<engine::EngineConfig>) -> Result<(), String> {
    stt.start(app, device, engine.unwrap_or_default())
}

/// Lo que hay en esta PC para reconocer voz: hardware, medición guardada
/// (si es de esta máquina) y si hay clave de xAI.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    hardware: engine::Hardware,
    report: Option<engine::Report>,
    xai: bool,
    slow_rtf: f32,
}

#[tauri::command(async)]
fn engine_info(app: AppHandle) -> Result<EngineInfo, String> {
    let hardware = engine::detect();
    let report = engine::saved_report(&stt::config_dir(&app)?, &hardware);
    Ok(EngineInfo { hardware, report, xai: engine::xai_key().is_some(), slow_rtf: engine::SLOW_RTF })
}

/// Mide de nuevo cada acelerador. Tarda unos segundos por cada uno.
#[tauri::command(async)]
fn engine_bench(app: AppHandle, stt: State<'_, stt::Stt>) -> Result<Option<engine::Report>, String> {
    if stt.is_running() {
        return Err("Pausá la escucha para medir".into());
    }
    stt.report(&app, true)
}

/// Prueba la otra PC antes de usarla.
#[tauri::command(async)]
fn engine_remote_check(url: String, key: String) -> Result<engine::RemoteHealth, String> {
    engine::Remote::new(&url, &key)?.health()
}

#[tauri::command(async)]
fn share_info(app: AppHandle, share: State<'_, share::Share>) -> Result<share::ShareInfo, String> {
    Ok(share.info(&stt::config_dir(&app)?))
}

/// Compartir el reconocimiento de esta PC con la tailnet, con el mejor acelerador medido.
#[tauri::command(async)]
fn share_start(app: AppHandle, share: State<'_, share::Share>, stt: State<'_, stt::Stt>) -> Result<share::ShareInfo, String> {
    let dir = model::model_dir(&app)?;
    if !model::is_present(&dir) {
        return Err("Para compartir, esta PC necesita el modelo bajado".into());
    }
    let accel = stt.report(&app, false)?.and_then(|r| r.best).unwrap_or(engine::Accel::Cpu);
    share.start(&stt::config_dir(&app)?, stt.slot(), dir, accel)
}

#[tauri::command(async)]
fn share_stop(app: AppHandle, share: State<'_, share::Share>) -> Result<share::ShareInfo, String> {
    share.stop();
    Ok(share.info(&stt::config_dir(&app)?))
}

#[tauri::command(async)]
fn stt_stop(stt: State<'_, stt::Stt>) {
    stt.stop()
}

#[tauri::command]
fn llm_status() -> llm::Status {
    llm::status()
}

/// Un pedido a DeepSeek que devuelve JSON. Los prompts los arma la interfaz.
#[tauri::command(async)]
fn llm_json(system: String, user: String, max_tokens: Option<u32>) -> Result<String, String> {
    llm::json(&system, &user, max_tokens.unwrap_or(800))
}

/// Dirección y token para el QR del iPhone.
#[tauri::command(async)]
fn phone_info(phone: State<'_, phone::Phone>) -> phone::Info {
    phone.info()
}

/// El link temporal por internet (Tailscale Funnel), para cuando el teléfono
/// no resuelve los nombres de la tailnet.
#[tauri::command(async)]
fn phone_public(phone: State<'_, phone::Phone>, on: bool) -> Result<phone::Info, String> {
    if on != phone.is_public() {
        phone.set_public(on)?;
    }
    Ok(phone.info())
}

/// Prepara la toma del iPhone: llega en pedazos por POST /rec y va a la
/// carpeta de tomas como `base.mp4`.
#[tauri::command(async)]
fn phone_take_begin(app: AppHandle, phone: State<'_, phone::Phone>, take: String, base: String) -> Result<(), String> {
    phone.take_begin(&take, &rec::folder(&app)?, &base)
}

#[tauri::command(async)]
fn phone_take_end(phone: State<'_, phone::Phone>, take: String) -> Result<rec::Saved, String> {
    phone.take_end(&take)
}

/// Una frase del coach en MP3 (base64, por lo mismo que `rec_write`).
#[tauri::command]
async fn tts_edge(text: String, voice: String, rate: Option<i32>) -> Result<String, String> {
    use base64::Engine;
    let mp3 = tts::edge(&text, &voice, rate.unwrap_or(0)).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(mp3))
}

/// Nombre de la salida de audio predeterminada, para saber si hay auriculares.
#[tauri::command(async)]
fn audio_output() -> Option<String> {
    tts::default_output()
}

#[tauri::command]
fn rec_folder(app: AppHandle) -> Result<String, String> {
    rec::folder(&app).map(|p| p.display().to_string())
}

#[tauri::command(async)]
fn rec_start(app: AppHandle, rec: State<'_, rec::Rec>, name: String) -> Result<String, String> {
    rec.start(&app, &name)
}

/// Un pedazo del video en base64. Binario crudo sería más liviano, pero si el
/// protocolo de IPC falla una vez, Tauri pasa a postMessage y ahí los bytes
/// llegan como una lista JSON de números; un texto llega igual por los dos.
#[tauri::command(async)]
fn rec_write(rec: State<'_, rec::Rec>, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Pedazo de video dañado: {e}"))?;
    rec.write(&bytes)
}

#[tauri::command(async)]
fn rec_stop(rec: State<'_, rec::Rec>) -> Result<rec::Saved, String> {
    rec.stop()
}

/// Abre el Explorador con la toma marcada. Solo dentro de la carpeta de tomas.
#[tauri::command]
fn rec_reveal(app: AppHandle, path: String) -> Result<(), String> {
    let dir = rec::folder(&app)?;
    let file = std::path::PathBuf::from(&path);
    let inside = file.canonicalize().ok().zip(dir.canonicalize().ok()).is_some_and(|(f, d)| f.starts_with(d));
    if !inside {
        return Err("Esa ruta no es una toma".into());
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    std::process::Command::new(std::path::Path::new(&root).join("explorer.exe"))
        .arg(format!("/select,{}", file.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No pude abrir el Explorador: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(stt::Stt::default())
        .manage(Downloading::default())
        .manage(rec::Rec::default())
        .manage(share::Share::default())
        .manage(phone::Phone::start())
        .invoke_handler(tauri::generate_handler![
            model_info,
            model_download,
            list_inputs,
            stt_start,
            stt_stop,
            llm_status,
            llm_json,
            rec_folder,
            rec_start,
            rec_write,
            rec_stop,
            rec_reveal,
            phone_info,
            phone_public,
            phone_take_begin,
            phone_take_end,
            tts_edge,
            audio_output,
            engine_info,
            engine_bench,
            engine_remote_check,
            share_info,
            share_start,
            share_stop
        ])
        .build(tauri::generate_context!())
        .expect("no pude arrancar la app")
        .run(|app, event| {
            // Que el link temporal no quede abierto con la app cerrada.
            if let tauri::RunEvent::Exit = event {
                let phone = tauri::Manager::state::<phone::Phone>(app);
                if phone.is_public() {
                    let _ = phone.set_public(false);
                }
                tauri::Manager::state::<share::Share>(app).stop();
            }
        });
}
