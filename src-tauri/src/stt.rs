//! El hilo que escucha: micrófono → frases → Parakeet → eventos a la interfaz.

use crate::prosody::{self, Prosody};
use crate::{audio, model, segmenter::Segmenter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

#[derive(Default)]
pub struct Stt {
    running: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
    model: Arc<Mutex<Option<ParakeetModel>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Text {
    text: String,
    ms: u64,
    /// Solo en las finales: cómo se dijo la frase entera.
    prosody: Option<Prosody>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Level {
    level: f32,
    speaking: bool,
    /// Silencio digital: el micrófono está abierto pero manda ceros (muteado).
    silent: bool,
}

/// Por debajo de esto (unos -70 dBFS) no hay ni el ruido de la sala: el
/// micrófono está muteado o con la ganancia en cero.
const DEAD_PEAK: f32 = 3e-4;
const DEAD_AFTER: Duration = Duration::from_secs(4);

fn status(app: &AppHandle, state: &'static str, message: Option<String>) {
    let _ = app.emit("stt://status", Status { state, message });
}

impl Stt {
    pub fn start(&self, app: AppHandle, device: Option<String>) -> Result<(), String> {
        self.stop();
        let dir = model::model_dir(&app)?;
        if !model::is_present(&dir) {
            return Err("El modelo no está bajado".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let slot = self.model.clone();
        let flag = stop.clone();
        let handle = std::thread::spawn(move || worker(app, dir, device, flag, slot));
        *self.running.lock().map_err(|e| e.to_string())? = Some((stop, handle));
        Ok(())
    }

    pub fn stop(&self) {
        let taken = self.running.lock().ok().and_then(|mut r| r.take());
        if let Some((stop, handle)) = taken {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
        }
    }
}

fn worker(
    app: AppHandle,
    dir: PathBuf,
    device: Option<String>,
    stop: Arc<AtomicBool>,
    slot: Arc<Mutex<Option<ParakeetModel>>>,
) {
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(e) => return status(&app, "error", Some(e.to_string())),
    };
    if guard.is_none() {
        status(&app, "loading", None);
        match ParakeetModel::load(&dir, &Quantization::Int8) {
            Ok(m) => *guard = Some(m),
            Err(e) => return status(&app, "error", Some(format!("No pude cargar el modelo: {e}"))),
        }
    }
    let Some(model) = guard.as_mut() else { return };

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let stream = match audio::open_input(device.as_deref(), tx) {
        Ok(s) => s,
        Err(e) => return status(&app, "error", Some(e)),
    };
    status(&app, "listening", None);

    let options = TranscribeOptions { language: Some("es".into()), ..Default::default() };
    let mut seg = Segmenter::new();
    let mut last_level = Instant::now();
    let mut last_sound = Instant::now();

    let mut run = |samples: &[f32], event: &str, with_prosody: bool| {
        let t0 = Instant::now();
        match model.transcribe(samples, &options) {
            Ok(r) => {
                let text = r.text.trim().to_string();
                if !text.is_empty() {
                    let ms = t0.elapsed().as_millis() as u64;
                    let prosody = with_prosody.then(|| prosody::analyze(samples));
                    let _ = app.emit(event, Text { text, ms, prosody });
                }
            }
            Err(e) => log::error!("transcripción: {e}"),
        }
    };

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) => {
                let mut peak = chunk.iter().fold(0f32, |m, s| m.max(s.abs()));
                seg.push(&chunk);
                // Lo que se acumuló mientras se transcribía entra de una.
                while let Ok(more) = rx.try_recv() {
                    peak = more.iter().fold(peak, |m, s| m.max(s.abs()));
                    seg.push(&more);
                }
                if peak > DEAD_PEAK {
                    last_sound = Instant::now();
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if last_level.elapsed() >= Duration::from_millis(70) {
            last_level = Instant::now();
            let silent = last_sound.elapsed() >= DEAD_AFTER;
            let _ = app.emit("stt://level", Level { level: seg.level(), speaking: seg.speaking(), silent });
        }

        for utterance in seg.take_finals() {
            run(&utterance, "stt://final", true);
        }
        if let Some(partial) = seg.take_partial() {
            run(&partial, "stt://partial", false);
        }
    }

    drop(stream);
    status(&app, "stopped", None);
}
