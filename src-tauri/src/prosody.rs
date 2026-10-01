//! Cómo se dijo una frase: cuánto duró la voz, el tono (F0) y el volumen.
//! Todo local, sobre el mismo audio que se transcribe.

use crate::audio::RATE;
use serde::Serialize;

const WIN: usize = (RATE as usize) * 40 / 1000; // 40 ms
const HOP: usize = WIN / 2;
const MIN_F0: f32 = 70.0;
const MAX_F0: f32 = 400.0;
const YIN_THRESHOLD: f32 = 0.15;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prosody {
    /// Del primer al último tramo con voz: sirve para palabras por minuto.
    pub speech_s: f32,
    /// Mediana del tono en Hz, si hubo tramos con tono claro.
    pub f0_hz: Option<f32>,
    /// Cuánto se movió el tono, en semitonos (desvío). Bajo = voz plana.
    pub spread_st: Option<f32>,
    /// Volumen medio de los tramos con voz, en dBFS.
    pub level_db: f32,
}

pub fn analyze(samples: &[f32]) -> Prosody {
    let frames: Vec<&[f32]> = (0..)
        .map(|i| i * HOP)
        .take_while(|start| start + WIN <= samples.len())
        .map(|start| &samples[start..start + WIN])
        .collect();
    let rms: Vec<f32> = frames
        .iter()
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt())
        .collect();

    // Umbral relativo a la frase: lo que está muy por debajo de lo más fuerte
    // es silencio o respiración.
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let p90 = sorted.get(sorted.len() * 9 / 10).copied().unwrap_or(0.0);
    let gate = (p90 * 0.2).max(0.008);

    let voiced: Vec<usize> = (0..rms.len()).filter(|&i| rms[i] > gate).collect();
    let speech_s = match (voiced.first(), voiced.last()) {
        (Some(a), Some(b)) => ((b - a) * HOP + WIN) as f32 / RATE as f32,
        _ => 0.0,
    };

    let level = if voiced.is_empty() {
        0.0
    } else {
        voiced.iter().map(|&i| rms[i]).sum::<f32>() / voiced.len() as f32
    };
    let level_db = 20.0 * level.max(1e-6).log10();

    let mut f0: Vec<f32> = voiced.iter().filter_map(|&i| yin(frames[i])).collect();
    let (f0_hz, spread_st) = if f0.len() >= 5 {
        f0.sort_by(|a, b| a.total_cmp(b));
        let median = f0[f0.len() / 2];
        let st: Vec<f32> = f0.iter().map(|f| 12.0 * (f / median).log2()).collect();
        let mean = st.iter().sum::<f32>() / st.len() as f32;
        let var = st.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / st.len() as f32;
        (Some(median), Some(var.sqrt()))
    } else {
        (None, None)
    };

    Prosody { speech_s, f0_hz, spread_st, level_db }
}

/// YIN (de Cheveigné y Kawahara, 2002) sobre un tramo de 40 ms.
fn yin(frame: &[f32]) -> Option<f32> {
    let min_tau = (RATE as f32 / MAX_F0) as usize;
    let max_tau = (RATE as f32 / MIN_F0) as usize;
    let w = frame.len().checked_sub(max_tau)?;

    let mut d = vec![0.0f32; max_tau + 1];
    for (tau, slot) in d.iter_mut().enumerate().skip(1) {
        *slot = (0..w).map(|j| (frame[j] - frame[j + tau]).powi(2)).sum();
    }
    // Diferencia normalizada por la media acumulada.
    let mut cmnd = vec![1.0f32; max_tau + 1];
    let mut running = 0.0;
    for tau in 1..=max_tau {
        running += d[tau];
        cmnd[tau] = if running > 0.0 { d[tau] * tau as f32 / running } else { 1.0 };
    }

    let mut tau = min_tau;
    while tau <= max_tau {
        if cmnd[tau] < YIN_THRESHOLD {
            while tau + 1 <= max_tau && cmnd[tau + 1] < cmnd[tau] {
                tau += 1;
            }
            // Interpolación parabólica para no quedar atado al entero.
            let refined = if tau > 1 && tau < max_tau {
                let (a, b, c) = (cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]);
                let den = a - 2.0 * b + c;
                if den.abs() > 1e-9 { tau as f32 + 0.5 * (a - c) / den } else { tau as f32 }
            } else {
                tau as f32
            };
            return Some(RATE as f32 / refined);
        }
        tau += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        let n = (RATE as f32 * secs) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                // Con armónicos, como una voz y no un silbido.
                amp * ((2.0 * std::f32::consts::PI * hz * t).sin()
                    + 0.5 * (4.0 * std::f32::consts::PI * hz * t).sin())
            })
            .collect()
    }

    #[test]
    fn finds_the_pitch_of_a_steady_tone() {
        let p = analyze(&tone(150.0, 1.0, 0.2));
        let f0 = p.f0_hz.expect("sin tono");
        assert!((f0 - 150.0).abs() < 3.0, "{f0}");
        assert!(p.spread_st.unwrap() < 0.3);
        assert!((p.speech_s - 1.0).abs() < 0.05, "{}", p.speech_s);
    }

    #[test]
    fn speech_time_ignores_silence_around() {
        let mut s = vec![0.0; RATE as usize / 2];
        s.extend(tone(220.0, 1.0, 0.2));
        s.extend(vec![0.0; RATE as usize]);
        let p = analyze(&s);
        assert!((p.speech_s - 1.0).abs() < 0.06, "{}", p.speech_s);
        assert!((p.f0_hz.unwrap() - 220.0).abs() < 4.0);
    }

    #[test]
    fn silence_has_no_pitch() {
        let p = analyze(&vec![0.0; RATE as usize]);
        assert!(p.f0_hz.is_none());
        assert_eq!(p.speech_s, 0.0);
    }
}
