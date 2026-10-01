//! Grabación: la interfaz manda los pedazos que arma MediaRecorder y acá se
//! escriben a disco a medida que llegan. Si la app se cierra de golpe, lo
//! grabado hasta ahí queda en el archivo.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

struct Open {
    file: BufWriter<File>,
    path: PathBuf,
    bytes: u64,
}

#[derive(Default)]
pub struct Rec(Mutex<Option<Open>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub path: String,
    pub bytes: u64,
}

/// `Videos\Apuntador`, o donde diga `APUNTADOR_VIDEO_DIR`.
pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("APUNTADOR_VIDEO_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let videos = app.path().video_dir().map_err(|e| format!("No encuentro la carpeta Videos: {e}"))?;
    Ok(videos.join("Apuntador"))
}

/// Solo letras, números, guiones y un punto: el nombre lo arma la interfaz.
pub(crate) fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok { Ok(name) } else { Err(format!("Nombre de archivo inválido: {name}")) }
}

impl Rec {
    pub fn start(&self, app: &AppHandle, name: &str) -> Result<String, String> {
        self.start_in(&folder(app)?, name)
    }

    fn start_in(&self, dir: &std::path::Path, name: &str) -> Result<String, String> {
        let mut slot = self.0.lock().map_err(|_| "grabación trabada")?;
        if slot.is_some() {
            return Err("Ya se está grabando".into());
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("No pude crear {}: {e}", dir.display()))?;
        let path = dir.join(safe_name(name)?);
        // create_new: nunca pisar una toma anterior.
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("No pude crear {}: {e}", path.display()))?;
        let shown = path.display().to_string();
        *slot = Some(Open { file: BufWriter::with_capacity(1 << 20, file), path, bytes: 0 });
        Ok(shown)
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "grabación trabada")?;
        let open = slot.as_mut().ok_or("No hay una grabación abierta")?;
        open.file.write_all(data).map_err(|e| format!("No pude escribir: {e}"))?;
        // Que lo grabado esté en disco, no solo en memoria.
        open.file.flush().map_err(|e| format!("No pude escribir: {e}"))?;
        open.bytes += data.len() as u64;
        Ok(())
    }

    pub fn stop(&self) -> Result<Saved, String> {
        let mut slot = self.0.lock().map_err(|_| "grabación trabada")?;
        let mut open = slot.take().ok_or("No hay una grabación abierta")?;
        open.file.flush().map_err(|e| format!("No pude cerrar: {e}"))?;
        open.file.get_ref().sync_all().map_err(|e| format!("No pude cerrar: {e}"))?;
        Ok(Saved { path: open.path.display().to_string(), bytes: open.bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_name, Rec};

    #[test]
    fn names() {
        assert!(safe_name("toma-2026-09-30_12-00-00.mkv").is_ok());
        assert!(safe_name("../toma.mkv").is_err());
        assert!(safe_name("a\\b.mkv").is_err());
        assert!(safe_name(".mkv").is_err());
        assert!(safe_name("").is_err());
    }

    #[test]
    fn writes_chunks_and_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("apuntador-rec-{}", std::process::id()));
        let rec = Rec::default();
        rec.start_in(&dir, "toma.mkv").unwrap();
        assert!(rec.start_in(&dir, "otra.mkv").is_err(), "una sola toma a la vez");
        rec.write(b"abc").unwrap();
        rec.write(b"de").unwrap();
        let saved = rec.stop().unwrap();
        assert_eq!(saved.bytes, 5);
        assert_eq!(std::fs::read(dir.join("toma.mkv")).unwrap(), b"abcde");
        assert!(rec.write(b"x").is_err(), "cerrada no escribe");
        assert!(rec.start_in(&dir, "toma.mkv").is_err(), "no pisa una toma");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
