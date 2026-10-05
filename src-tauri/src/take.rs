//! La toma que graba el iPhone a calidad completa. El teléfono la manda en
//! pedazos numerados por POST /rec (ver phone.rs) mientras graba, y acá se
//! escriben en orden a medida que llegan. Si un pedazo se reenvía (se perdió
//! la respuesta), se acepta sin escribirlo dos veces.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::rec::{safe_name, Saved};

/// Lo que puede mandar el teléfono según su navegador.
const EXTENSIONS: [&str; 3] = ["mp4", "mov", "webm"];

struct Take {
    id: String,
    dir: PathBuf,
    base: String,
    /// Se abre con el primer pedazo, cuando ya se sabe el formato.
    file: Option<(BufWriter<File>, PathBuf)>,
    bytes: u64,
    next: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Put {
    Written,
    /// Ya estaba escrito: el teléfono reintentó.
    Repeated,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutError {
    /// No es la toma abierta (terminó, o es de antes).
    Unknown,
    /// Falta un pedazo anterior.
    Gap { expected: u64 },
    Invalid(String),
    Io(String),
}

#[derive(Default)]
pub struct Takes(Mutex<Option<Take>>);

impl Takes {
    /// Prepara la toma; el archivo se crea con el primer pedazo. Una toma
    /// que todavía no recibió nada se reemplaza.
    pub fn begin(&self, id: &str, dir: &Path, base: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Toma inválida".into());
        }
        safe_name(base)?;
        let mut slot = self.0.lock().map_err(|_| "toma trabada")?;
        if slot.as_ref().is_some_and(|t| t.file.is_some()) {
            return Err("El iPhone ya está grabando una toma".into());
        }
        *slot = Some(Take { id: id.into(), dir: dir.into(), base: base.into(), file: None, bytes: 0, next: 0 });
        Ok(())
    }

    pub fn put(&self, id: &str, seq: u64, ext: &str, data: &[u8]) -> Result<Put, PutError> {
        let mut slot = self.0.lock().map_err(|_| PutError::Io("toma trabada".into()))?;
        let take = slot.as_mut().filter(|t| t.id == id).ok_or(PutError::Unknown)?;
        if seq < take.next {
            return Ok(Put::Repeated);
        }
        if seq > take.next {
            return Err(PutError::Gap { expected: take.next });
        }
        if take.file.is_none() {
            if !EXTENSIONS.contains(&ext) {
                return Err(PutError::Invalid(format!("Formato desconocido: {ext}")));
            }
            std::fs::create_dir_all(&take.dir).map_err(|e| PutError::Io(format!("No pude crear {}: {e}", take.dir.display())))?;
            let path = take.dir.join(format!("{}.{ext}", take.base));
            // create_new: nunca pisar una toma anterior.
            let file = File::options()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| PutError::Io(format!("No pude crear {}: {e}", path.display())))?;
            take.file = Some((BufWriter::with_capacity(1 << 20, file), path));
        }
        let (file, _) = take.file.as_mut().expect("abierto arriba");
        file.write_all(data).and_then(|_| file.flush()).map_err(|e| PutError::Io(format!("No pude escribir: {e}")))?;
        take.bytes += data.len() as u64;
        take.next += 1;
        Ok(Put::Written)
    }

    /// Cierra la toma con lo que haya llegado.
    pub fn end(&self, id: &str) -> Result<Saved, String> {
        let mut slot = self.0.lock().map_err(|_| "toma trabada")?;
        if !slot.as_ref().is_some_and(|t| t.id == id) {
            return Err("No hay una toma del iPhone abierta".into());
        }
        let take = slot.take().expect("revisado arriba");
        let Some((mut file, path)) = take.file else {
            return Err("No llegó nada del iPhone".into());
        };
        file.flush().map_err(|e| format!("No pude cerrar: {e}"))?;
        file.get_ref().sync_all().map_err(|e| format!("No pude cerrar: {e}"))?;
        Ok(Saved { path: path.display().to_string(), bytes: take.bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("apuntador-take-{name}-{}", std::process::id()))
    }

    #[test]
    fn writes_in_order_and_tolerates_retries() {
        let d = dir("orden");
        let takes = Takes::default();
        takes.begin("abc", &d, "toma-iphone").unwrap();
        assert_eq!(takes.put("abc", 0, "mp4", b"ab"), Ok(Put::Written));
        assert_eq!(takes.put("abc", 0, "mp4", b"ab"), Ok(Put::Repeated));
        assert_eq!(takes.put("abc", 2, "mp4", b"x"), Err(PutError::Gap { expected: 1 }));
        assert_eq!(takes.put("abc", 1, "mp4", b"cd"), Ok(Put::Written));
        assert_eq!(takes.put("otra", 2, "mp4", b"x"), Err(PutError::Unknown));
        let saved = takes.end("abc").unwrap();
        assert_eq!(saved.bytes, 4);
        assert_eq!(std::fs::read(d.join("toma-iphone.mp4")).unwrap(), b"abcd");
        assert_eq!(takes.put("abc", 2, "mp4", b"x"), Err(PutError::Unknown), "cerrada no escribe");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn guards() {
        let d = dir("guardas");
        let takes = Takes::default();
        assert!(takes.begin("a/b", &d, "toma").is_err());
        assert!(takes.begin("abc", &d, "../toma").is_err());
        takes.begin("abc", &d, "toma").unwrap();
        assert!(matches!(takes.put("abc", 0, "exe", b"x"), Err(PutError::Invalid(_))));
        assert!(takes.end("abc").is_err(), "sin pedazos no hay archivo");
        // Una toma sin nada se reemplaza; una con datos no.
        takes.begin("uno", &d, "toma").unwrap();
        takes.begin("dos", &d, "toma").unwrap();
        takes.put("dos", 0, "mp4", b"x").unwrap();
        assert!(takes.begin("tres", &d, "toma2").is_err());
        takes.end("dos").unwrap();
        // No pisa la anterior.
        takes.begin("cuatro", &d, "toma").unwrap();
        assert!(matches!(takes.put("cuatro", 0, "mp4", b"y"), Err(PutError::Io(_))));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
