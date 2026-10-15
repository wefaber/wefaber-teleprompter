//! El mazo de una presentación: una carpeta con `guion.md` y los archivos que
//! muestra la ventana del público.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Lee `guion.md` de la carpeta. `None` si no hay.
pub fn read_script(dir: &Path) -> Result<Option<String>, String> {
    let file = dir.join("guion.md");
    if !file.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&file)
        .map(Some)
        .map_err(|e| format!("No pude leer {}: {e}", file.display()))
}

/// Habilita la carpeta para el protocolo de assets (de ahí se cargan las
/// diapositivas y los videos) y devuelve su guion. El permiso no se guarda:
/// la interfaz lo vuelve a pedir al abrir la app.
#[tauri::command]
pub fn deck_open(app: AppHandle, folder: String) -> Result<Option<String>, String> {
    let dir = PathBuf::from(&folder);
    if !dir.is_dir() {
        return Err(format!("No existe la carpeta {folder}"));
    }
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("No pude abrir la carpeta: {e}"))?;
    read_script(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_guion_de_la_carpeta() {
        let dir = std::env::temp_dir().join(format!("apuntador-mazo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_script(&dir).unwrap(), None);
        std::fs::write(dir.join("guion.md"), "# Hola").unwrap();
        assert_eq!(read_script(&dir).unwrap().as_deref(), Some("# Hola"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
