//! Dónde vive el modelo y cómo se baja.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Parakeet TDT 0.6B v3 en ONNX int8: 25 idiomas, español incluido.
pub const MODEL_NAME: &str = "parakeet-tdt-0.6b-v3-int8";
const MODEL_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const REQUIRED: [&str; 4] = [
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub present: bool,
    pub path: String,
    pub name: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    stage: &'static str,
}

/// `APUNTADOR_MODEL_DIR` apunta a una carpeta ya bajada; si no, va a los datos
/// de la app.
pub fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("APUNTADOR_MODEL_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("models").join(MODEL_NAME))
}

pub fn is_present(dir: &Path) -> bool {
    REQUIRED.iter().all(|f| dir.join(f).is_file())
}

pub fn info(app: &AppHandle) -> Result<ModelInfo, String> {
    let dir = model_dir(app)?;
    Ok(ModelInfo { present: is_present(&dir), path: dir.display().to_string(), name: MODEL_NAME })
}

/// Baja y descomprime el modelo. Avisa el avance por `model://progress`.
pub fn download(app: &AppHandle) -> Result<(), String> {
    let target = model_dir(app)?;
    let models = target.parent().ok_or("Ruta de modelo inválida")?.to_path_buf();
    fs::create_dir_all(&models).map_err(|e| e.to_string())?;

    let archive = models.join(".descarga.tar.gz");
    let staging = models.join(".descomprimiendo");

    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(MODEL_URL).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("La descarga respondió {}", resp.status()));
    }
    let total = resp.content_length();
    let mut file = fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 16];
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        if downloaded - last_emit >= 1 << 20 {
            last_emit = downloaded;
            let _ = app.emit("model://progress", Progress { downloaded, total, stage: "download" });
        }
    }
    drop(file);

    let _ = app.emit("model://progress", Progress { downloaded, total, stage: "extract" });
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(fs::File::open(&archive).map_err(|e| e.to_string())?);
    tar::Archive::new(gz).unpack(&staging).map_err(|e| e.to_string())?;

    let found = find_model(&staging).ok_or("El archivo bajado no trae los archivos del modelo")?;
    let _ = fs::remove_dir_all(&target);
    fs::rename(&found, &target).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive);

    if !is_present(&target) {
        return Err("Faltan archivos del modelo después de descomprimir".into());
    }
    Ok(())
}

fn find_model(dir: &Path) -> Option<PathBuf> {
    if is_present(dir) {
        return Some(dir.to_path_buf());
    }
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .find_map(|e| find_model(&e.path()))
}
