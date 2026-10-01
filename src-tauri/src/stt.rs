//! El hilo que escucha: micrófono → frases → motor (esta PC, otra PC o xAI,
//! ver `engine.rs`) → eventos a la interfaz.

use crate::engine::{self, Engine, EngineConfig, Mode, Slot};
use crate::prosody::{self, Prosody};
use crate::{audio, model, segmenter::Segmenter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct Stt {
    running: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
    slot: Slot,
    /// Para que dos mediciones no se pisen.
    measuring: Mutex<()>,
}

/// Qué motor quedó andando, para mostrarlo.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EngineEvent {
    label: String,
    note: Option<String>,
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

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

impl Stt {
    pub fn slot(&self) -> Slot {
        self.slot.clone()
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().is_ok_and(|r| r.is_some())
    }

    pub fn start(&self, app: AppHandle, device: Option<String>, cfg: EngineConfig) -> Result<(), String> {
        self.stop();
        let dir = model::model_dir(&app)?;
        let needs_model = matches!(cfg.mode, Mode::Local);
        if needs_model && !model::is_present(&dir) {
            return Err("El modelo no está bajado".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let slot = self.slot.clone();
        let flag = stop.clone();
        let handle = std::thread::spawn(move || worker(app, dir, device, cfg, flag, slot));
        *self.running.lock().map_err(|e| e.to_string())? = Some((stop, handle));
        Ok(())
    }

    /// La medición guardada, o una nueva si no hay o cambió el hardware.
    pub fn report(&self, app: &AppHandle, fresh: bool) -> Result<Option<engine::Report>, String> {
        let dir = model::model_dir(app)?;
        if !model::is_present(&dir) {
            return Ok(None);
        }
        let _one = self.measuring.lock().map_err(|e| e.to_string())?;
        let config = config_dir(app)?;
        let hw = engine::detect();
        if !fresh {
            if let Some(r) = engine::saved_report(&config, &hw) {
                return Ok(Some(r));
            }
        }
        let report = engine::bench(&self.slot, &dir, hw);
        engine::save_report(&config, &report);
        Ok(Some(report))
    }

    pub fn stop(&self) {
        let taken = self.running.lock().ok().and_then(|mut r| r.take());
        if let Some((stop, handle)) = taken {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
        }
    }
}

/// Elige el motor según el modo. La primera vez en automático mide esta PC.
fn choose(app: &AppHandle, dir: &std::path::Path, cfg: &EngineConfig, slot: &Slot) -> Result<engine::Choice, String> {
    let stt = app.state::<Stt>();
    let measured = |app: &AppHandle| {
        if model::is_present(dir) && engine::saved_report(&config_dir(app)?, &engine::detect()).is_none() {
            status(app, "loading", Some("Midiendo qué tan rápido reconoce esta PC (solo la primera vez)…".into()));
        }
        stt.report(app, false)
    };
    match cfg.mode {
        Mode::Local => {
            let accel = match cfg.accel {
                Some(a) => a,
                None => measured(app)?.and_then(|r| r.best).unwrap_or(engine::Accel::Cpu),
            };
            Ok(engine::Choice { engine: engine::local(slot, dir, accel)?, note: None })
        }
        Mode::Remota => Ok(engine::Choice { engine: engine::remote(cfg)?, note: None }),
        Mode::Xai => Ok(engine::Choice { engine: Engine::Xai(engine::Xai::new(cfg.keyterms.clone())?), note: None }),
        Mode::Auto => {
            let report = measured(app)?;
            engine::auto(cfg, slot, dir, report.as_ref())
        }
    }
}

fn worker(app: AppHandle, dir: PathBuf, device: Option<String>, cfg: EngineConfig, stop: Arc<AtomicBool>, slot: Slot) {
    status(&app, "loading", None);
    let choice = match choose(&app, &dir, &cfg, &slot) {
        Ok(c) => c,
        Err(e) => return status(&app, "error", Some(e)),
    };
    let engine = choice.engine;
    let _ = app.emit("stt://engine", EngineEvent { label: engine.label(), note: choice.note });

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let stream = match audio::open_input(device.as_deref(), tx) {
        Ok(s) => s,
        Err(e) => return status(&app, "error", Some(e)),
    };
    status(&app, "listening", None);

    let mut seg = Segmenter::new();
    let mut last_level = Instant::now();
    let mut last_sound = Instant::now();

    let run = |samples: &[f32], event: &str, with_prosody: bool| {
        let t0 = Instant::now();
        match engine.transcribe(samples) {
            Ok(text) => {
                if !text.is_empty() {
                    let ms = t0.elapsed().as_millis() as u64;
                    let prosody = with_prosody.then(|| prosody::analyze(samples));
                    let _ = app.emit(event, Text { text, ms, prosody });
                }
            }
            Err(e) => {
                // Con otra PC o xAI el error suele ser de red: que se vea.
                log::error!("transcripción: {e}");
                let _ = app.emit("stt://problem", e);
            }
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
            if engine.partials() {
                run(&partial, "stt://partial", false);
            }
        }
    }

    drop(stream);
    status(&app, "stopped", None);
}
