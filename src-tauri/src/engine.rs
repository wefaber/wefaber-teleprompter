//! Dónde corre el reconocimiento de voz. En orden de preferencia:
//!
//! 1. **Esta PC**, con el acelerador más rápido que tenga (DirectML usa
//!    cualquier GPU de Windows; si no, la CPU). Cuál es lo decide una medición
//!    con un audio de prueba, no los specs: un nombre de GPU no dice si el
//!    modelo entero corre bien en ella.
//! 2. **Otra PC** de la tailnet que comparta su reconocimiento (`share.rs`).
//! 3. **xAI** (Grok Speech to Text), por internet, con `XAI_API_KEY`.
//!
//! Si esta PC tarda más de medio segundo por segundo de audio, las parciales
//! llegan tarde y el seguimiento se atrasa: ahí conviene pasar al siguiente.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use transcribe_rs::accel::{set_ort_accelerator, OrtAccelerator};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Frase de 7,2 s en español, PCM 16 kHz mono (ver `tts.rs`, `make_bench_clip`).
const BENCH_CLIP: &[u8] = include_bytes!("../assets/bench-es.pcm");
const SAMPLE_RATE: usize = 16_000;
/// Más lento que esto (segundos de proceso por segundo de audio), no sirve en vivo.
pub const SLOW_RTF: f32 = 0.5;
const XAI_URL: &str = "https://api.x.ai/v1/stt";
/// Límites de xAI para `keyterm`.
const MAX_KEYTERMS: usize = 100;
const MAX_KEYTERM_CHARS: usize = 50;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accel {
    Cpu,
    Directml,
}

impl Accel {
    fn ort(self) -> OrtAccelerator {
        match self {
            Accel::Cpu => OrtAccelerator::CpuOnly,
            Accel::Directml => OrtAccelerator::DirectMl,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Accel::Cpu => "CPU",
            Accel::Directml => "DirectML",
        }
    }
}

/// El modelo cargado y con qué acelerador. Lo comparten la escucha y el
/// servidor para otras PCs: un solo modelo en memoria.
pub type Slot = Arc<Mutex<Option<(Accel, ParakeetModel)>>>;

fn options() -> TranscribeOptions {
    TranscribeOptions { language: Some("es".into()), ..Default::default() }
}

/// Deja cargado el modelo con ese acelerador (si ya estaba, no hace nada).
pub fn ensure(slot: &Slot, dir: &Path, accel: Accel) -> Result<(), String> {
    let mut guard = slot.lock().map_err(|e| e.to_string())?;
    if matches!(&*guard, Some((a, _)) if *a == accel) {
        return Ok(());
    }
    // Liberar el anterior antes de cargar otro: son cerca de un giga.
    *guard = None;
    set_ort_accelerator(accel.ort());
    let model = ParakeetModel::load(dir, &Quantization::Int8).map_err(|e| format!("No pude cargar el modelo ({}): {e}", accel.label()))?;
    *guard = Some((accel, model));
    Ok(())
}

pub fn transcribe_local(slot: &Slot, samples: &[f32]) -> Result<String, String> {
    let mut guard = slot.lock().map_err(|e| e.to_string())?;
    let (_, model) = guard.as_mut().ok_or("El modelo no está cargado")?;
    model.transcribe(samples, &options()).map(|r| r.text.trim().to_string()).map_err(|e| e.to_string())
}

pub fn to_pcm16(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes()).collect()
}

pub fn from_pcm16(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0).collect()
}

// ---------------------------------------------------------------------------
// Hardware y medición
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub cpu: String,
    pub threads: u32,
    pub ram_gb: f32,
    pub gpus: Vec<String>,
    /// Procesadores neuronales (Intel AI Boost, AMD, Qualcomm Hexagon…).
    pub npus: Vec<String>,
}

impl Hardware {
    /// Lo que cambia la elección: si cambia, la medición vieja no vale.
    fn same_machine(&self, other: &Hardware) -> bool {
        self.cpu == other.cpu && self.gpus == other.gpus && self.npus == other.npus
    }
}

/// Adaptadores que no son una GPU de verdad.
fn real_gpu(name: &str) -> bool {
    let n = name.to_lowercase();
    !["basic display", "basic render", "remote display", "virtual", "parsec", "dummy"].iter().any(|v| n.contains(v))
}

#[derive(Deserialize)]
struct RawHardware {
    cpu: Option<String>,
    threads: Option<u32>,
    ram: Option<f64>,
    gpus: Option<Vec<String>>,
    npus: Option<Vec<String>>,
}

fn parse_hardware(json: &str) -> Option<Hardware> {
    let raw: RawHardware = serde_json::from_str(json).ok()?;
    Some(Hardware {
        cpu: raw.cpu.unwrap_or_default().trim().to_string(),
        threads: raw.threads.unwrap_or(0),
        ram_gb: (raw.ram.unwrap_or(0.0) / 1_073_741_824.0) as f32,
        gpus: raw.gpus.unwrap_or_default().into_iter().filter(|g| real_gpu(g)).collect(),
        npus: raw.npus.unwrap_or_default(),
    })
}

pub fn detect() -> Hardware {
    let threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0);
    let fallback = Hardware { threads, ..Default::default() };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const SCRIPT: &str = "$c = Get-CimInstance Win32_Processor | Select-Object -First 1; \
            $g = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }); \
            $n = @(Get-PnpDevice -Class ComputeAccelerator -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object { $_.FriendlyName }); \
            $m = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; \
            @{ cpu = $c.Name; threads = $c.NumberOfLogicalProcessors; ram = $m; gpus = $g; npus = $n } | ConvertTo-Json -Compress";
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let exe = Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let out = std::process::Command::new(exe)
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .creation_flags(0x0800_0000)
            .output();
        if let Ok(out) = out {
            if let Some(hw) = parse_hardware(&String::from_utf8_lossy(&out.stdout)) {
                return hw;
            }
        }
    }
    fallback
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    pub accel: Accel,
    /// Segundos de proceso por segundo de audio: 0,1 es diez veces más rápido que en vivo.
    pub rtf: Option<f32>,
    pub load_ms: u64,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub hardware: Hardware,
    pub trials: Vec<Trial>,
    pub best: Option<Accel>,
    pub at: u64,
}

impl Report {
    pub fn best_rtf(&self) -> Option<f32> {
        let best = self.best?;
        self.trials.iter().find(|t| t.accel == best).and_then(|t| t.rtf)
    }
}

/// Qué vale la pena probar en esta máquina.
pub fn candidates(hw: &Hardware) -> Vec<Accel> {
    let mut c = Vec::new();
    if cfg!(windows) && (!hw.gpus.is_empty() || !hw.npus.is_empty()) {
        c.push(Accel::Directml);
    }
    c.push(Accel::Cpu);
    c
}

/// El más rápido de los que anduvieron.
pub fn pick(trials: &[Trial]) -> Option<Accel> {
    trials
        .iter()
        .filter_map(|t| t.rtf.map(|r| (t.accel, r)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(a, _)| a)
}

/// Carga el modelo con cada acelerador y mide cuánto tarda en reconocer la
/// frase de prueba. Deja cargado el mejor.
pub fn bench(slot: &Slot, dir: &Path, hardware: Hardware) -> Report {
    let clip = from_pcm16(BENCH_CLIP);
    let seconds = clip.len() as f32 / SAMPLE_RATE as f32;
    let mut trials = Vec::new();
    for accel in candidates(&hardware) {
        let t0 = Instant::now();
        if let Err(e) = ensure(slot, dir, accel) {
            trials.push(Trial { accel, rtf: None, load_ms: 0, error: Some(e) });
            continue;
        }
        let load_ms = t0.elapsed().as_millis() as u64;
        // La primera pasada calienta (DirectML compila en ella); se miden las otras dos.
        let run = || transcribe_local(slot, &clip);
        let trial = match run() {
            Ok(text) if text.split_whitespace().count() >= 5 => {
                let t1 = Instant::now();
                let ok = run().and_then(|_| run());
                match ok {
                    Ok(_) => Trial { accel, rtf: Some(t1.elapsed().as_secs_f32() / 2.0 / seconds), load_ms, error: None },
                    Err(e) => Trial { accel, rtf: None, load_ms, error: Some(e) },
                }
            }
            Ok(text) => Trial { accel, rtf: None, load_ms, error: Some(format!("Reconoció mal la frase de prueba: \"{text}\"")) },
            Err(e) => Trial { accel, rtf: None, load_ms, error: Some(e) },
        };
        log::info!("medición {}: {:?}", accel.label(), trial.rtf);
        trials.push(trial);
    }
    let best = pick(&trials);
    if let Some(b) = best {
        let _ = ensure(slot, dir, b);
    }
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Report { hardware, trials, best, at }
}

pub fn report_path(config: &Path) -> PathBuf {
    config.join("motor.json")
}

/// La medición guardada, si es de esta misma máquina.
pub fn saved_report(config: &Path, hw: &Hardware) -> Option<Report> {
    let raw = std::fs::read_to_string(report_path(config)).ok()?;
    let report: Report = serde_json::from_str(&raw).ok()?;
    report.hardware.same_machine(hw).then_some(report)
}

pub fn save_report(config: &Path, report: &Report) {
    let _ = std::fs::create_dir_all(config);
    if let Ok(json) = serde_json::to_string_pretty(report) {
        let _ = std::fs::write(report_path(config), json);
    }
}

// ---------------------------------------------------------------------------
// Motores
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Auto,
    Local,
    Remota,
    Xai,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    #[serde(default)]
    pub mode: Mode,
    /// Forzar un acelerador en esta PC; si no, el de la medición.
    pub accel: Option<Accel>,
    pub remote_url: Option<String>,
    pub remote_key: Option<String>,
    /// Las claves del guion: xAI las usa para no equivocarse con nombres y siglas.
    #[serde(default)]
    pub keyterms: Vec<String>,
}

pub struct Remote {
    client: reqwest::blocking::Client,
    base: String,
    key: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHealth {
    pub name: String,
    pub accel: Option<Accel>,
}

#[derive(Deserialize, Serialize)]
pub struct Transcript {
    pub text: String,
}

impl Remote {
    pub fn new(url: &str, key: &str) -> Result<Self, String> {
        let base = url.trim().trim_end_matches('/').to_string();
        if !base.starts_with("https://") && !base.starts_with("http://") {
            return Err("La dirección de la otra PC tiene que empezar con https://".into());
        }
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
        Ok(Remote { client, base, key: key.trim().to_string() })
    }

    pub fn health(&self) -> Result<RemoteHealth, String> {
        let resp = self
            .client
            .get(format!("{}/stt/health", self.base))
            .bearer_auth(&self.key)
            .timeout(Duration::from_secs(4))
            .send()
            .map_err(|e| format!("No llego a la otra PC: {e}"))?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("La otra PC no aceptó la clave".into());
        }
        if !resp.status().is_success() {
            return Err(format!("La otra PC respondió {}", resp.status()));
        }
        resp.json().map_err(|e| e.to_string())
    }

    fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let resp = self
            .client
            .post(format!("{}/stt", self.base))
            .bearer_auth(&self.key)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(to_pcm16(samples))
            .send()
            .map_err(|e| format!("La otra PC no respondió: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(format!("La otra PC respondió {status}: {}", body.chars().take(200).collect::<String>()));
        }
        resp.json::<Transcript>().map(|t| t.text).map_err(|e| e.to_string())
    }
}

pub fn xai_key() -> Option<String> {
    std::env::var("XAI_API_KEY").ok().filter(|k| !k.trim().is_empty())
}

/// Los campos de texto del pedido a xAI, en orden (el archivo va al final).
pub fn xai_fields(keyterms: &[String]) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("language", "es".to_string()),
        ("audio_format", "pcm".to_string()),
        ("sample_rate", SAMPLE_RATE.to_string()),
    ];
    let mut seen = std::collections::HashSet::new();
    for term in keyterms {
        let t: String = term.trim().chars().take(MAX_KEYTERM_CHARS).collect();
        if t.is_empty() || !seen.insert(t.to_lowercase()) {
            continue;
        }
        if seen.len() > MAX_KEYTERMS {
            break;
        }
        fields.push(("keyterm", t));
    }
    fields
}

pub struct Xai {
    client: reqwest::blocking::Client,
    key: String,
    keyterms: Vec<String>,
}

impl Xai {
    pub fn new(keyterms: Vec<String>) -> Result<Self, String> {
        let key = xai_key().ok_or("Falta XAI_API_KEY en el entorno")?;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        Ok(Xai { client, key, keyterms })
    }

    fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let mut form = reqwest::blocking::multipart::Form::new();
        for (name, value) in xai_fields(&self.keyterms) {
            form = form.text(name, value);
        }
        let file = reqwest::blocking::multipart::Part::bytes(to_pcm16(samples)).file_name("frase.pcm");
        form = form.part("file", file);
        let resp = self
            .client
            .post(XAI_URL)
            .bearer_auth(&self.key)
            .multipart(form)
            .send()
            .map_err(|e| format!("xAI no respondió: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(format!("xAI respondió {status}: {}", body.chars().take(200).collect::<String>()));
        }
        resp.json::<Transcript>().map(|t| t.text.trim().to_string()).map_err(|e| e.to_string())
    }
}

pub enum Engine {
    Local { slot: Slot, accel: Accel },
    Remote(Remote, String),
    Xai(Xai),
}

impl Engine {
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        match self {
            Engine::Local { slot, .. } => transcribe_local(slot, samples),
            Engine::Remote(r, _) => r.transcribe(samples),
            Engine::Xai(x) => x.transcribe(samples),
        }
    }

    /// xAI cobra cada pedido: solo las frases terminadas, sin parciales.
    pub fn partials(&self) -> bool {
        !matches!(self, Engine::Xai(_))
    }

    pub fn label(&self) -> String {
        match self {
            Engine::Local { accel, .. } => format!("Esta PC · {}", accel.label()),
            Engine::Remote(_, name) => format!("Otra PC · {name}"),
            Engine::Xai(_) => "xAI".into(),
        }
    }
}

/// Qué se eligió y por qué, para mostrarlo.
pub struct Choice {
    pub engine: Engine,
    pub note: Option<String>,
}

pub fn local(slot: &Slot, dir: &Path, accel: Accel) -> Result<Engine, String> {
    ensure(slot, dir, accel)?;
    Ok(Engine::Local { slot: slot.clone(), accel })
}

pub fn remote(cfg: &EngineConfig) -> Result<Engine, String> {
    let url = cfg.remote_url.as_deref().filter(|u| !u.trim().is_empty()).ok_or("Falta la dirección de la otra PC")?;
    let r = Remote::new(url, cfg.remote_key.as_deref().unwrap_or(""))?;
    let health = r.health()?;
    Ok(Engine::Remote(r, health.name))
}

/// En automático: esta PC si da, si no la otra PC, si no xAI. `report` es
/// la medición (si el modelo está bajado).
pub fn auto(cfg: &EngineConfig, slot: &Slot, dir: &Path, report: Option<&Report>) -> Result<Choice, String> {
    let local_best = report.and_then(|r| r.best.map(|b| (b, r.best_rtf().unwrap_or(f32::MAX))));
    if let Some((accel, rtf)) = local_best {
        if rtf <= SLOW_RTF {
            return Ok(Choice { engine: local(slot, dir, accel)?, note: None });
        }
    }
    let mut why = Vec::new();
    if cfg.remote_url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
        match remote(cfg) {
            Ok(engine) => return Ok(Choice { engine, note: Some("Esta PC es lenta para reconocer: uso la otra PC.".into()) }),
            Err(e) => why.push(e),
        }
    }
    if xai_key().is_some() {
        let engine = Engine::Xai(Xai::new(cfg.keyterms.clone())?);
        return Ok(Choice { engine, note: Some("Esta PC es lenta para reconocer: uso xAI.".into()) });
    }
    match local_best {
        Some((accel, _)) => {
            why.push("esta PC es lenta y no hay otra PC ni xAI configurados".into());
            Ok(Choice { engine: local(slot, dir, accel)?, note: Some(format!("Va a ir atrasado: {}.", why.join("; "))) })
        }
        None => Err(if why.is_empty() { "El modelo no está bajado y no hay otra PC ni xAI configurados".into() } else { why.join("; ") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_round_trip() {
        let s = [0.0, 0.5, -0.5, 1.0, -1.0];
        let back = from_pcm16(&to_pcm16(&s));
        for (a, b) in s.iter().zip(&back) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
    }

    #[test]
    fn bench_clip_is_seven_seconds_of_16k_mono() {
        let secs = BENCH_CLIP.len() as f32 / 2.0 / SAMPLE_RATE as f32;
        assert!((6.0..9.0).contains(&secs), "{secs}");
    }

    #[test]
    fn reads_powershell_hardware() {
        let json = r#"{"cpu":"AMD Ryzen 7 5700X 8-Core Processor ","threads":16,"ram":34252922880,"gpus":["NVIDIA GeForce RTX 5070","Microsoft Basic Display Adapter"],"npus":[]}"#;
        let hw = parse_hardware(json).unwrap();
        assert_eq!(hw.cpu, "AMD Ryzen 7 5700X 8-Core Processor");
        assert_eq!(hw.gpus, vec!["NVIDIA GeForce RTX 5070"]);
        assert!((hw.ram_gb - 31.9).abs() < 0.1);
    }

    #[test]
    fn tries_the_gpu_only_if_there_is_one() {
        let none = Hardware::default();
        assert_eq!(candidates(&none), vec![Accel::Cpu]);
        let gpu = Hardware { gpus: vec!["Intel(R) Arc(TM) Graphics".into()], ..Default::default() };
        let expected = if cfg!(windows) { vec![Accel::Directml, Accel::Cpu] } else { vec![Accel::Cpu] };
        assert_eq!(candidates(&gpu), expected);
    }

    #[test]
    fn picks_the_fastest_that_worked() {
        let t = |accel, rtf: Option<f32>| Trial { accel, rtf, load_ms: 0, error: None };
        assert_eq!(pick(&[t(Accel::Directml, Some(0.04)), t(Accel::Cpu, Some(0.12))]), Some(Accel::Directml));
        assert_eq!(pick(&[t(Accel::Directml, None), t(Accel::Cpu, Some(0.9))]), Some(Accel::Cpu));
        assert_eq!(pick(&[t(Accel::Cpu, None)]), None);
    }

    #[test]
    fn xai_request_respects_its_limits() {
        let mut terms: Vec<String> = (0..150).map(|i| format!("clave {i}")).collect();
        terms.push("CLAVE 0".into()); // repetida
        terms.push("x".repeat(80));
        let fields = xai_fields(&terms);
        assert_eq!(&fields[..3], &[("language", "es".into()), ("audio_format", "pcm".into()), ("sample_rate", "16000".into())]);
        let keyterms: Vec<_> = fields.iter().filter(|(k, _)| *k == "keyterm").collect();
        assert_eq!(keyterms.len(), 100);
        assert!(keyterms.iter().all(|(_, v)| v.chars().count() <= 50));
    }

    /// Mide esta PC con el modelo real (el bajado por la app o `APUNTADOR_MODEL_DIR`).
    /// `cargo test --release --lib real_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_bench() {
        let dir = std::env::var("APUNTADOR_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("APPDATA").unwrap()).join("net.wefaber.apuntador").join("models").join("parakeet-tdt-0.6b-v3-int8")
        });
        let hw = detect();
        println!("{hw:?}");
        let slot = Slot::default();
        let report = bench(&slot, &dir, hw);
        for t in &report.trials {
            println!("{:>8}: rtf {:?}, carga {} ms, error {:?}", t.accel.label(), t.rtf, t.load_ms, t.error);
        }
        println!("mejor: {:?}", report.best);
        println!("dice: {}", transcribe_local(&slot, &from_pcm16(BENCH_CLIP)).unwrap());
        assert!(report.best.is_some());
    }

    #[test]
    fn remote_needs_a_real_address() {
        assert!(Remote::new("one.tail.ts.net:5191", "k").is_err());
        assert!(Remote::new("https://one.tail.ts.net:5191/", "k").is_ok());
    }
}
