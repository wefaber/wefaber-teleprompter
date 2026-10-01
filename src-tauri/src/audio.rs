//! Captura del micrófono con cpal, pasada a 16 kHz mono, que es lo que espera
//! Parakeet.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::Sender;

pub const RATE: u32 = 16_000;

pub fn list_inputs() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devices| devices.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// Abre la entrada y manda bloques de muestras a 16 kHz por `tx`. El stream
/// sigue vivo mientras no se suelte lo que devuelve.
pub fn open_input(name: Option<&str>, tx: Sender<Vec<f32>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = match name {
        Some(wanted) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == wanted).unwrap_or(false))
            .ok_or_else(|| format!("No encuentro el micrófono \"{wanted}\""))?,
        None => host
            .default_input_device()
            .ok_or("No hay ningún micrófono conectado")?,
    };

    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate().0;
    let config: cpal::StreamConfig = supported.config();
    let err_fn = |err| log::error!("audio: {err}");

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => {
            let mut rs = Resampler::new(rate);
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let _ = tx.send(rs.process(data.chunks(channels).map(mean)));
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut rs = Resampler::new(rate);
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let frames = data.chunks(channels).map(|f| {
                        f.iter().map(|s| *s as f32 / 32_768.0).sum::<f32>() / f.len() as f32
                    });
                    let _ = tx.send(rs.process(frames));
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut rs = Resampler::new(rate);
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let frames = data.chunks(channels).map(|f| {
                        f.iter().map(|s| (*s as f32 - 32_768.0) / 32_768.0).sum::<f32>()
                            / f.len() as f32
                    });
                    let _ = tx.send(rs.process(frames));
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("El micrófono entrega un formato que no manejo: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn mean(frame: &[f32]) -> f32 {
    frame.iter().sum::<f32>() / frame.len() as f32
}

/// Biquad pasabajos (RBJ), forma directa transpuesta II.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn lowpass(fs: f32, fc: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * fc / fs;
        let alpha = w0.sin() / (2.0 * q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) / 2.0 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Pasabajos de cuarto orden a 7 kHz y después interpolación lineal. Para
/// reconocimiento de voz alcanza y no suma dependencias.
struct Resampler {
    step: f64,
    t: f64,
    prev: f32,
    filters: Vec<Biquad>,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        let filters = if rate > RATE {
            vec![
                Biquad::lowpass(rate as f32, 7_000.0, 0.541),
                Biquad::lowpass(rate as f32, 7_000.0, 1.307),
            ]
        } else {
            Vec::new()
        };
        Self { step: rate as f64 / RATE as f64, t: 0.0, prev: 0.0, filters }
    }

    fn process(&mut self, input: impl Iterator<Item = f32>) -> Vec<f32> {
        let mut out = Vec::new();
        for sample in input {
            let cur = self.filters.iter_mut().fold(sample, |x, f| f.run(x));
            while self.t <= 1.0 {
                out.push(self.prev + (cur - self.prev) * self.t as f32);
                self.t += self.step;
            }
            self.t -= 1.0;
            self.prev = cur;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_48k_gives_a_third() {
        let mut rs = Resampler::new(48_000);
        let out = rs.process(std::iter::repeat(0.0).take(48_000));
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
    }

    #[test]
    fn resample_44k1_keeps_duration() {
        let mut rs = Resampler::new(44_100);
        let out = rs.process(std::iter::repeat(0.0).take(44_100 * 2));
        assert!((out.len() as i64 - 32_000).abs() <= 1, "{}", out.len());
    }

    /// A mano, con el micrófono de verdad:
    /// `APUNTADOR_MIC="Microphone (HyperX Quadcast)" cargo test --lib real_mic -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_mic() {
        let host = cpal::default_host();
        for d in host.input_devices().unwrap() {
            let name = d.name().unwrap_or_default();
            let config = d.default_input_config().map(|c| format!("{c:?}")).unwrap_or_else(|e| e.to_string());
            println!("entrada: {name} · {config}");
        }
        let wanted = std::env::var("APUNTADOR_MIC").ok();
        let (tx, rx) = std::sync::mpsc::channel();
        let stream = open_input(wanted.as_deref(), tx).expect("abrir el micrófono");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let (mut n, mut sum, mut peak) = (0usize, 0f64, 0f32);
        while std::time::Instant::now() < until {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                for s in chunk {
                    n += 1;
                    sum += (s as f64) * (s as f64);
                    peak = peak.max(s.abs());
                }
            }
        }
        drop(stream);
        let rms = (sum / n.max(1) as f64).sqrt();
        println!("muestras a 16 kHz: {n} (esperadas ~48000) · rms {rms:.5} · pico {peak:.4}");
        assert!(n > 40_000, "casi no llegaron muestras");
    }
}
