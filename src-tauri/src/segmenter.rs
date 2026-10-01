//! Corta el audio en frases por energía, para transcribir mientras se habla.
//!
//! Parakeet no es un modelo de streaming: transcribe un bloque entero. Para que
//! el apuntador reaccione antes de que termine la frase, la frase en curso se
//! vuelve a transcribir cada tanto (parcial) y al cerrarse se transcribe una
//! vez más (final).

use crate::audio::RATE;

const FRAME: usize = (RATE as usize) * 30 / 1000; // 30 ms
const PREROLL_FRAMES: usize = 10; // 300 ms antes de que arranque la voz
const END_SILENCE_MS: u32 = 650;
const MAX_UTTERANCE: usize = (RATE as usize) * 12;
const PARTIAL_EVERY: usize = (RATE as usize) * 8 / 10;
const MIN_PARTIAL: usize = (RATE as usize) * 6 / 10;

pub struct Segmenter {
    pending: Vec<f32>,
    preroll: std::collections::VecDeque<Vec<f32>>,
    utterance: Vec<f32>,
    in_speech: bool,
    silence_ms: u32,
    last_partial_len: usize,
    floor: f32,
    finals: Vec<Vec<f32>>,
    level: f32,
}

impl Segmenter {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            preroll: std::collections::VecDeque::new(),
            utterance: Vec::new(),
            in_speech: false,
            silence_ms: 0,
            last_partial_len: 0,
            floor: 0.01,
            finals: Vec::new(),
            level: 0.0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= FRAME {
            let frame: Vec<f32> = self.pending.drain(..FRAME).collect();
            self.frame(frame);
        }
    }

    fn frame(&mut self, frame: Vec<f32>) {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        self.level = rms;
        let voiced = rms > (self.floor * 2.5).max(0.006);
        // El piso de ruido baja rápido y sube solo en silencio: sigue al
        // ambiente sin que un monólogo largo lo empuje para arriba.
        if rms < self.floor {
            self.floor = self.floor * 0.9 + rms * 0.1;
        } else if !voiced {
            self.floor = self.floor * 0.98 + rms * 0.02;
        }

        if !self.in_speech {
            if voiced {
                self.in_speech = true;
                self.silence_ms = 0;
                self.last_partial_len = 0;
                self.utterance = self.preroll.drain(..).flatten().collect();
                self.utterance.extend_from_slice(&frame);
            } else {
                self.preroll.push_back(frame);
                if self.preroll.len() > PREROLL_FRAMES {
                    self.preroll.pop_front();
                }
            }
            return;
        }

        self.utterance.extend_from_slice(&frame);
        self.silence_ms = if voiced { 0 } else { self.silence_ms + 30 };

        if self.silence_ms >= END_SILENCE_MS {
            self.in_speech = false;
            self.finals.push(std::mem::take(&mut self.utterance));
        } else if self.utterance.len() >= MAX_UTTERANCE {
            // Frase larga sin pausa: se cierra acá y sigue en una nueva.
            self.finals.push(std::mem::take(&mut self.utterance));
            self.last_partial_len = 0;
        }
    }

    /// Frases cerradas desde la última llamada.
    pub fn take_finals(&mut self) -> Vec<Vec<f32>> {
        std::mem::take(&mut self.finals)
    }

    /// La frase en curso, si creció lo suficiente desde el último parcial.
    pub fn take_partial(&mut self) -> Option<Vec<f32>> {
        let len = self.utterance.len();
        if self.in_speech && len >= MIN_PARTIAL && len - self.last_partial_len >= PARTIAL_EVERY {
            self.last_partial_len = len;
            return Some(self.utterance.clone());
        }
        None
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn speaking(&self) -> bool {
        self.in_speech
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: usize, amp: f32) -> Vec<f32> {
        let n = RATE as usize * ms / 1000;
        (0..n).map(|i| amp * ((i as f32) * 0.3).sin()).collect()
    }

    #[test]
    fn closes_an_utterance_after_silence() {
        let mut seg = Segmenter::new();
        seg.push(&tone(1_000, 0.0005));
        seg.push(&tone(1_500, 0.2));
        assert!(seg.speaking());
        assert!(seg.take_partial().is_some());
        seg.push(&tone(1_000, 0.0005));
        let finals = seg.take_finals();
        assert_eq!(finals.len(), 1);
        assert!(finals[0].len() >= RATE as usize * 3 / 2);
        assert!(!seg.speaking());
    }

    #[test]
    fn splits_long_speech() {
        let mut seg = Segmenter::new();
        seg.push(&tone(500, 0.0005));
        seg.push(&tone(13_000, 0.2));
        assert_eq!(seg.take_finals().len(), 1);
        assert!(seg.speaking());
    }
}
