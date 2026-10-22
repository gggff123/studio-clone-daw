//! Original DSP effects used by the native mix engine and offline export.
//!
//! All processing is stereo. Effect instances keep their own delay/filter
//! state so tails survive sequential blocks. Parameter changes are read from
//! the project snapshot for each block; no frontend call is made from the
//! audio path.

use crate::project::{EffectKind, InsertEffect};

const MAX_DELAY_SECONDS: f32 = 2.0;
const REVERB_SPREAD: usize = 23;

fn clamp_param(effect: &InsertEffect, key: &str, default: f64, min: f64, max: f64) -> f32 {
    let value = effect.param(key, default);
    if value.is_finite() {
        value.clamp(min, max) as f32
    } else {
        default.clamp(min, max) as f32
    }
}

fn db_gain(db: f32) -> f32 {
    if db <= -96.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

#[derive(Clone, Copy, Debug, Default)]
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
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        if y.is_finite() {
            y
        } else {
            self.z1 = 0.0;
            self.z2 = 0.0;
            0.0
        }
    }

    fn set_peaking(sample_rate: f32, freq: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * (freq / sample_rate).clamp(1.0e-5, 0.49);
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        let cos = w0.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha / a) / a0,
            ..Default::default()
        }
    }

    fn set_low_shelf(sample_rate: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * (freq / sample_rate).clamp(1.0e-5, 0.49);
        let cos = w0.cos();
        let sin = w0.sin();
        let alpha = sin / std::f32::consts::SQRT_2;
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        let a0 = (a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha;
        Self {
            b0: (a * ((a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha)) / a0,
            b1: (2.0 * a * ((a - 1.0) - (a + 1.0) * cos)) / a0,
            b2: (a * ((a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha)) / a0,
            a1: (-2.0 * ((a - 1.0) + (a + 1.0) * cos)) / a0,
            a2: ((a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha) / a0,
            ..Default::default()
        }
    }

    fn set_high_shelf(sample_rate: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * (freq / sample_rate).clamp(1.0e-5, 0.49);
        let cos = w0.cos();
        let sin = w0.sin();
        let alpha = sin / std::f32::consts::SQRT_2;
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        let a0 = (a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha;
        Self {
            b0: (a * ((a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha)) / a0,
            b1: (-2.0 * a * ((a - 1.0) + (a + 1.0) * cos)) / a0,
            b2: (a * ((a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha)) / a0,
            a1: (2.0 * ((a - 1.0) - (a + 1.0) * cos)) / a0,
            a2: ((a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha) / a0,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Eq3 {
    low_l: Biquad,
    low_r: Biquad,
    mid_l: Biquad,
    mid_r: Biquad,
    high_l: Biquad,
    high_r: Biquad,
    last_params: Option<(f32, f32, f32, f32)>,
}

impl Eq3 {
    fn update(&mut self, sr: f32, low: f32, mid: f32, high: f32, mid_freq: f32) {
        let key = (low, mid, high, mid_freq);
        if self.last_params == Some(key) {
            return;
        }
        self.last_params = Some(key);
        self.low_l = Biquad::set_low_shelf(sr, 120.0, low);
        self.low_r = Biquad::set_low_shelf(sr, 120.0, low);
        self.mid_l = Biquad::set_peaking(sr, mid_freq, 0.9, mid);
        self.mid_r = Biquad::set_peaking(sr, mid_freq, 0.9, mid);
        self.high_l = Biquad::set_high_shelf(sr, 7_000.0, high);
        self.high_r = Biquad::set_high_shelf(sr, 7_000.0, high);
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Parametric {
    l: [Biquad; 2],
    r: [Biquad; 2],
    last: Option<(f32, f32, f32)>,
}

impl Parametric {
    fn update(&mut self, sr: f32, freq: f32, gain: f32, q: f32) {
        let key = (freq, gain, q);
        if self.last == Some(key) {
            return;
        }
        self.last = Some(key);
        self.l = [
            Biquad::set_peaking(sr, freq, q, gain),
            Biquad::set_peaking(sr, (freq * 1.7).min(sr * 0.45), q, gain * 0.5),
        ];
        self.r = self.l;
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Compressor {
    env_gr: f32,
    attack_coeff: f32,
    release_coeff: f32,
}

impl Default for Compressor {
    fn default() -> Self {
        Self {
            env_gr: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Limiter {
    env_gr: f32,
    release_coeff: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Self {
            env_gr: 0.0,
            release_coeff: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Gate {
    gain: f32,
    open: bool,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            gain: 0.0,
            open: false,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Delay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    delay_samples: f32,
    sample_rate: f32,
    primed: bool,
}

impl Delay {
    fn new(sample_rate: u32) -> Self {
        let len = (sample_rate as f32 * MAX_DELAY_SECONDS) as usize + 4;
        Self {
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            write: 0,
            delay_samples: sample_rate as f32 * 0.25,
            sample_rate: sample_rate as f32,
            primed: false,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Reverb {
    combs_l: [Vec<f32>; 4],
    combs_r: [Vec<f32>; 4],
    comb_idx_l: [usize; 4],
    comb_idx_r: [usize; 4],
    comb_filter_l: [f32; 4],
    comb_filter_r: [f32; 4],
    allpass_l: [Vec<f32>; 2],
    allpass_r: [Vec<f32>; 2],
    allpass_idx_l: [usize; 2],
    allpass_idx_r: [usize; 2],
}

impl Reverb {
    fn new(sample_rate: u32) -> Self {
        let scale = sample_rate as f32 / 44_100.0;
        let comb_tunings = [1116usize, 1188, 1277, 1356];
        let allpass_tunings = [556usize, 441];
        let alloc = |len: usize| vec![0.0; (len as f32 * scale) as usize + 1];
        Self {
            combs_l: [
                alloc(comb_tunings[0]),
                alloc(comb_tunings[1]),
                alloc(comb_tunings[2]),
                alloc(comb_tunings[3]),
            ],
            combs_r: [
                alloc(comb_tunings[0] + REVERB_SPREAD),
                alloc(comb_tunings[1] + REVERB_SPREAD),
                alloc(comb_tunings[2] + REVERB_SPREAD),
                alloc(comb_tunings[3] + REVERB_SPREAD),
            ],
            comb_idx_l: [0; 4],
            comb_idx_r: [0; 4],
            comb_filter_l: [0.0; 4],
            comb_filter_r: [0.0; 4],
            allpass_l: [alloc(allpass_tunings[0]), alloc(allpass_tunings[1])],
            allpass_r: [
                alloc(allpass_tunings[0] + REVERB_SPREAD),
                alloc(allpass_tunings[1] + REVERB_SPREAD),
            ],
            allpass_idx_l: [0; 2],
            allpass_idx_r: [0; 2],
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Chorus {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    phase: f32,
    sample_rate: f32,
}

impl Chorus {
    fn new(sample_rate: u32) -> Self {
        let len = (sample_rate as f32 * 0.08) as usize + 8;
        Self {
            buf_l: vec![0.0; len],
            buf_r: vec![0.0; len],
            write: 0,
            phase: 0.0,
            sample_rate: sample_rate as f32,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum EffectState {
    Gain,
    Pan,
    Eq3(Eq3),
    Parametric(Parametric),
    Compressor(Compressor),
    Limiter(Limiter),
    Gate(Gate),
    Delay(Delay),
    Reverb(Reverb),
    Chorus(Chorus),
}

impl EffectState {
    pub(crate) fn new(kind: &EffectKind, sample_rate: u32) -> Self {
        match kind {
            EffectKind::Gain => EffectState::Gain,
            EffectKind::Pan => EffectState::Pan,
            EffectKind::Eq3 => EffectState::Eq3(Eq3::default()),
            EffectKind::Parametric => EffectState::Parametric(Parametric::default()),
            EffectKind::Compressor => EffectState::Compressor(Compressor::default()),
            EffectKind::Limiter => EffectState::Limiter(Limiter::default()),
            EffectKind::NoiseGate => EffectState::Gate(Gate::default()),
            EffectKind::Delay => EffectState::Delay(Delay::new(sample_rate)),
            EffectKind::Reverb => EffectState::Reverb(Reverb::new(sample_rate)),
            EffectKind::Chorus => EffectState::Chorus(Chorus::new(sample_rate)),
        }
    }

    pub(crate) fn matches(&self, kind: &EffectKind) -> bool {
        matches!(
            (self, kind),
            (EffectState::Gain, EffectKind::Gain)
                | (EffectState::Pan, EffectKind::Pan)
                | (EffectState::Eq3(_), EffectKind::Eq3)
                | (EffectState::Parametric(_), EffectKind::Parametric)
                | (EffectState::Compressor(_), EffectKind::Compressor)
                | (EffectState::Limiter(_), EffectKind::Limiter)
                | (EffectState::Gate(_), EffectKind::NoiseGate)
                | (EffectState::Delay(_), EffectKind::Delay)
                | (EffectState::Reverb(_), EffectKind::Reverb)
                | (EffectState::Chorus(_), EffectKind::Chorus)
        )
    }

    pub(crate) fn process(
        &mut self,
        effect: &InsertEffect,
        left: &mut [f32],
        right: &mut [f32],
        sample_rate: u32,
    ) {
        if !effect.enabled {
            return;
        }
        let frames = left.len().min(right.len());
        let sr = sample_rate as f32;
        match self {
            EffectState::Gain => {
                let gain = db_gain(clamp_param(effect, "gainDb", 0.0, -60.0, 24.0));
                for i in 0..frames {
                    left[i] *= gain;
                    right[i] *= gain;
                }
            }
            EffectState::Pan => {
                let pan = clamp_param(effect, "pan", 0.0, -1.0, 1.0);
                let theta = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
                let gl = theta.cos();
                let gr = theta.sin();
                for i in 0..frames {
                    left[i] *= gl;
                    right[i] *= gr;
                }
            }
            EffectState::Eq3(state) => {
                let low = clamp_param(effect, "lowDb", 0.0, -18.0, 18.0);
                let mid = clamp_param(effect, "midDb", 0.0, -18.0, 18.0);
                let high = clamp_param(effect, "highDb", 0.0, -18.0, 18.0);
                let mid_freq = clamp_param(effect, "midFreq", 1_000.0, 100.0, 12_000.0);
                state.update(sr, low, mid, high, mid_freq);
                for i in 0..frames {
                    left[i] = state
                        .high_l
                        .process(state.mid_l.process(state.low_l.process(left[i])));
                    right[i] = state
                        .high_r
                        .process(state.mid_r.process(state.low_r.process(right[i])));
                }
            }
            EffectState::Parametric(state) => {
                let freq = clamp_param(effect, "freq", 1_000.0, 30.0, 18_000.0);
                let gain = clamp_param(effect, "gainDb", 0.0, -18.0, 18.0);
                let q = clamp_param(effect, "q", 1.0, 0.1, 12.0);
                state.update(sr, freq, gain, q);
                for i in 0..frames {
                    let l = state.l[0].process(left[i]);
                    left[i] = state.l[1].process(l);
                    let r = state.r[0].process(right[i]);
                    right[i] = state.r[1].process(r);
                }
            }
            EffectState::Compressor(state) => {
                let threshold = clamp_param(effect, "threshold", -18.0, -60.0, 0.0);
                let ratio = clamp_param(effect, "ratio", 4.0, 1.0, 20.0);
                let attack_ms = clamp_param(effect, "attack", 10.0, 0.1, 200.0);
                let release_ms = clamp_param(effect, "release", 120.0, 5.0, 2_000.0);
                let makeup = clamp_param(effect, "makeup", 0.0, 0.0, 24.0);
                state.attack_coeff = (-1.0 / (attack_ms * 0.001 * sr)).exp();
                state.release_coeff = (-1.0 / (release_ms * 0.001 * sr)).exp();
                for i in 0..frames {
                    let level = left[i].abs().max(right[i].abs()).max(1.0e-9);
                    let level_db = 20.0 * level.log10();
                    let over = (level_db - threshold).max(0.0);
                    let target = over * (1.0 - 1.0 / ratio);
                    let coeff = if target > state.env_gr {
                        state.attack_coeff
                    } else {
                        state.release_coeff
                    };
                    state.env_gr = target + coeff * (state.env_gr - target);
                    let gain = db_gain(-state.env_gr + makeup);
                    left[i] *= gain;
                    right[i] *= gain;
                }
            }
            EffectState::Limiter(state) => {
                let threshold = clamp_param(effect, "threshold", -0.3, -24.0, 0.0);
                let release_ms = clamp_param(effect, "release", 80.0, 5.0, 1_000.0);
                state.release_coeff = (-1.0 / (release_ms * 0.001 * sr)).exp();
                let ceiling = db_gain(threshold);
                for i in 0..frames {
                    let peak = left[i].abs().max(right[i].abs());
                    let target_gr = if peak > ceiling && peak > 1.0e-9 {
                        20.0 * (peak / ceiling).log10()
                    } else {
                        0.0
                    };
                    if target_gr > state.env_gr {
                        state.env_gr = target_gr;
                    } else {
                        state.env_gr =
                            target_gr + state.release_coeff * (state.env_gr - target_gr);
                    }
                    let gain = db_gain(-state.env_gr);
                    left[i] = (left[i] * gain).clamp(-1.0, 1.0);
                    right[i] = (right[i] * gain).clamp(-1.0, 1.0);
                }
            }
            EffectState::Gate(state) => {
                let threshold = clamp_param(effect, "threshold", -55.0, -90.0, -6.0);
                let attack_ms = clamp_param(effect, "attack", 2.0, 0.1, 100.0);
                let release_ms = clamp_param(effect, "release", 100.0, 5.0, 1_000.0);
                let attack = (-1.0 / (attack_ms * 0.001 * sr)).exp();
                let release = (-1.0 / (release_ms * 0.001 * sr)).exp();
                let threshold_gain = db_gain(threshold);
                for i in 0..frames {
                    let level = left[i].abs().max(right[i].abs());
                    if level > threshold_gain {
                        state.open = true;
                    } else if level < threshold_gain * 0.5 {
                        state.open = false;
                    }
                    let target = if state.open { 1.0 } else { 0.0 };
                    let coeff = if target > state.gain {
                        attack
                    } else {
                        release
                    };
                    state.gain = target + coeff * (state.gain - target);
                    left[i] *= state.gain;
                    right[i] *= state.gain;
                }
            }
            EffectState::Delay(state) => {
                let time_ms = clamp_param(effect, "timeMs", 350.0, 1.0, 2_000.0);
                let feedback = clamp_param(effect, "feedback", 0.35, 0.0, 0.95);
                let mix = clamp_param(effect, "mix", 0.25, 0.0, 1.0);
                let ping_pong = effect.param("pingPong", 0.0) > 0.5;
                let target = (time_ms * 0.001 * state.sample_rate)
                    .clamp(1.0, state.buf_l.len() as f32 - 3.0);
                if !state.primed {
                    // Start at the requested time instead of gliding from the
                    // default. Gliding from 250 ms would smear the first repeats.
                    state.delay_samples = target;
                    state.primed = true;
                }
                let len = state.buf_l.len();
                for i in 0..frames {
                    state.delay_samples += (target - state.delay_samples) * 0.0008;
                    let read_pos = (state.write as f32 - state.delay_samples + len as f32)
                        % len as f32;
                    let i0 = read_pos.floor() as usize % len;
                    let i1 = (i0 + 1) % len;
                    let frac = read_pos - read_pos.floor();
                    let dl = state.buf_l[i0] * (1.0 - frac) + state.buf_l[i1] * frac;
                    let dr = state.buf_r[i0] * (1.0 - frac) + state.buf_r[i1] * frac;
                    let fb_l = if ping_pong { dr } else { dl };
                    let fb_r = if ping_pong { dl } else { dr };
                    state.buf_l[state.write] = left[i] + fb_l.clamp(-4.0, 4.0) * feedback;
                    state.buf_r[state.write] = right[i] + fb_r.clamp(-4.0, 4.0) * feedback;
                    left[i] = left[i] * (1.0 - mix) + dl * mix;
                    right[i] = right[i] * (1.0 - mix) + dr * mix;
                    state.write = (state.write + 1) % len;
                }
            }
            EffectState::Reverb(state) => {
                let size = clamp_param(effect, "size", 0.55, 0.0, 1.0);
                let damp = clamp_param(effect, "damp", 0.35, 0.0, 1.0);
                let mix = clamp_param(effect, "mix", 0.22, 0.0, 1.0);
                let feedback = 0.70 + 0.28 * size;
                let damp_coeff = 0.05 + 0.85 * damp;
                for i in 0..frames {
                    let input_l = left[i] * 0.35;
                    let input_r = right[i] * 0.35;
                    let mut wet_l = 0.0;
                    let mut wet_r = 0.0;
                    for c in 0..4 {
                        let len_l = state.combs_l[c].len();
                        let idx_l = state.comb_idx_l[c];
                        let out_l = state.combs_l[c][idx_l];
                        state.comb_filter_l[c] = out_l * (1.0 - damp_coeff)
                            + state.comb_filter_l[c] * damp_coeff;
                        state.combs_l[c][idx_l] = input_l + state.comb_filter_l[c] * feedback;
                        state.comb_idx_l[c] = (idx_l + 1) % len_l;
                        wet_l += out_l;

                        let len_r = state.combs_r[c].len();
                        let idx_r = state.comb_idx_r[c];
                        let out_r = state.combs_r[c][idx_r];
                        state.comb_filter_r[c] = out_r * (1.0 - damp_coeff)
                            + state.comb_filter_r[c] * damp_coeff;
                        state.combs_r[c][idx_r] = input_r + state.comb_filter_r[c] * feedback;
                        state.comb_idx_r[c] = (idx_r + 1) % len_r;
                        wet_r += out_r;
                    }
                    wet_l *= 0.25;
                    wet_r *= 0.25;
                    for a in 0..2 {
                        let len = state.allpass_l[a].len();
                        let idx = state.allpass_idx_l[a];
                        let delayed = state.allpass_l[a][idx];
                        let output = -wet_l + delayed;
                        state.allpass_l[a][idx] = wet_l + delayed * 0.5;
                        state.allpass_idx_l[a] = (idx + 1) % len;
                        wet_l = output;

                        let len = state.allpass_r[a].len();
                        let idx = state.allpass_idx_r[a];
                        let delayed = state.allpass_r[a][idx];
                        let output = -wet_r + delayed;
                        state.allpass_r[a][idx] = wet_r + delayed * 0.5;
                        state.allpass_idx_r[a] = (idx + 1) % len;
                        wet_r = output;
                    }
                    left[i] = left[i] * (1.0 - mix) + wet_l * mix;
                    right[i] = right[i] * (1.0 - mix) + wet_r * mix;
                }
            }
            EffectState::Chorus(state) => {
                let rate = clamp_param(effect, "rate", 0.8, 0.05, 8.0);
                let depth = clamp_param(effect, "depthMs", 4.0, 0.0, 12.0);
                let mix = clamp_param(effect, "mix", 0.35, 0.0, 1.0);
                let base_delay = 0.014 * state.sample_rate;
                let len = state.buf_l.len();
                for i in 0..frames {
                    state.phase += rate / state.sample_rate;
                    if state.phase >= 1.0 {
                        state.phase -= 1.0;
                    }
                    let lfo = (state.phase * std::f32::consts::TAU).sin();
                    let delay_l = base_delay + lfo * depth * 0.001 * state.sample_rate;
                    let delay_r = base_delay
                        + (state.phase * std::f32::consts::TAU + 1.7).sin()
                            * depth
                            * 0.001
                            * state.sample_rate;
                    let read = |buf: &[f32], delay: f32| {
                        let pos = (state.write as f32 - delay + len as f32) % len as f32;
                        let i0 = pos.floor() as usize % len;
                        let i1 = (i0 + 1) % len;
                        let frac = pos - pos.floor();
                        buf[i0] * (1.0 - frac) + buf[i1] * frac
                    };
                    let wet_l = read(&state.buf_l, delay_l);
                    let wet_r = read(&state.buf_r, delay_r);
                    state.buf_l[state.write] = (left[i] + wet_l * 0.2).clamp(-4.0, 4.0);
                    state.buf_r[state.write] = (right[i] + wet_r * 0.2).clamp(-4.0, 4.0);
                    left[i] = left[i] * (1.0 - mix) + wet_l * mix;
                    right[i] = right[i] * (1.0 - mix) + wet_r * mix;
                    state.write = (state.write + 1) % len;
                }
            }
        }
    }
}

/// Small helper used by the master output stage.
pub(crate) fn soft_clip(x: f32) -> f32 {
    let threshold = 0.94;
    if x.abs() <= threshold {
        x
    } else {
        let sign = x.signum();
        sign * (threshold + (1.0 - threshold) * ((x.abs() - threshold) / (1.0 - threshold)).tanh())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn effect(kind: EffectKind, params: &[(&str, f64)]) -> InsertEffect {
        let mut map = BTreeMap::new();
        for (k, v) in params {
            map.insert((*k).to_string(), *v);
        }
        InsertEffect {
            id: "fx".into(),
            kind,
            enabled: true,
            params: map,
        }
    }

    fn signal(frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = vec![0.0; frames];
        let mut r = vec![0.0; frames];
        for i in 0..frames {
            let s = (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5;
            l[i] = s;
            r[i] = s;
        }
        (l, r)
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0, |a, b| a.max(b.abs()))
    }

    #[test]
    fn gain_effect_applies_db() {
        let mut state = EffectState::new(&EffectKind::Gain, 48_000);
        let (mut l, mut r) = signal(512);
        state.process(&effect(EffectKind::Gain, &[("gainDb", -6.0)]), &mut l, &mut r, 48_000);
        assert!((peak(&l) - 0.5 * 0.501_187).abs() < 0.005);
    }

    #[test]
    fn bypass_is_silent_change() {
        let mut state = EffectState::new(&EffectKind::Gain, 48_000);
        let (mut l, mut r) = signal(128);
        let before = l.clone();
        let mut fx = effect(EffectKind::Gain, &[("gainDb", -24.0)]);
        fx.enabled = false;
        state.process(&fx, &mut l, &mut r, 48_000);
        assert_eq!(l, before);
    }

    #[test]
    fn eq_and_param_eq_stay_finite() {
        for kind in [EffectKind::Eq3, EffectKind::Parametric] {
            let mut state = EffectState::new(&kind, 48_000);
            let (mut l, mut r) = signal(2_048);
            let fx = effect(
                kind,
                &[
                    ("lowDb", 6.0),
                    ("midDb", -4.0),
                    ("highDb", 3.0),
                    ("gainDb", 3.0),
                    ("freq", 2_000.0),
                    ("q", 1.4),
                ],
            );
            state.process(&fx, &mut l, &mut r, 48_000);
            assert!(l.iter().all(|s| s.is_finite()));
            assert!(peak(&l) > 0.01);
        }
    }

    #[test]
    fn compressor_reduces_loud_signal() {
        let mut state = EffectState::new(&EffectKind::Compressor, 48_000);
        let (mut l, mut r) = signal(9_600);
        let before = peak(&l);
        state.process(
            &effect(
                EffectKind::Compressor,
                &[
                    ("threshold", -30.0),
                    ("ratio", 8.0),
                    ("attack", 1.0),
                    ("release", 80.0),
                    ("makeup", 0.0),
                ],
            ),
            &mut l,
            &mut r,
            48_000,
        );
        assert!(peak(&l) < before);
    }

    #[test]
    fn limiter_never_exceeds_ceiling() {
        let mut state = EffectState::new(&EffectKind::Limiter, 48_000);
        let mut l = vec![1.5; 4_800];
        let mut r = vec![-1.5; 4_800];
        state.process(
            &effect(EffectKind::Limiter, &[("threshold", -1.0), ("release", 50.0)]),
            &mut l,
            &mut r,
            48_000,
        );
        assert!(peak(&l) <= 1.0 + 1e-6);
        assert!(peak(&r) <= 1.0 + 1e-6);
    }

    #[test]
    fn gate_attenuates_quiet_signal() {
        let mut state = EffectState::new(&EffectKind::NoiseGate, 48_000);
        let mut l = vec![0.0005; 9_600];
        let mut r = l.clone();
        state.process(
            &effect(
                EffectKind::NoiseGate,
                &[("threshold", -40.0), ("attack", 1.0), ("release", 20.0)],
            ),
            &mut l,
            &mut r,
            48_000,
        );
        assert!(peak(&l) < 0.0001);
    }

    #[test]
    fn delay_produces_a_tail() {
        let mut state = EffectState::new(&EffectKind::Delay, 48_000);
        let mut l = vec![0.0; 48_000];
        let mut r = vec![0.0; 48_000];
        l[0] = 0.8;
        r[0] = 0.8;
        state.process(
            &effect(
                EffectKind::Delay,
                &[("timeMs", 100.0), ("feedback", 0.3), ("mix", 0.5), ("pingPong", 0.0)],
            ),
            &mut l,
            &mut r,
            48_000,
        );
        assert!(l[4_700..4_900].iter().any(|s| s.abs() > 0.05));
    }

    #[test]
    fn reverb_and_chorus_generate_finite_signal() {
        for kind in [EffectKind::Reverb, EffectKind::Chorus] {
            let mut state = EffectState::new(&kind, 48_000);
            let (mut l, mut r) = signal(9_600);
            state.process(
                &effect(kind, &[("mix", 0.5), ("size", 0.7), ("depthMs", 5.0)]),
                &mut l,
                &mut r,
                48_000,
            );
            assert!(l.iter().all(|s| s.is_finite()));
            assert!(peak(&l) > 0.01);
        }
    }

    #[test]
    fn soft_clip_is_bounded() {
        assert!(soft_clip(10.0) <= 1.0);
        assert!(soft_clip(-10.0) >= -1.0);
        assert!(soft_clip(10.0) > 0.9);
        assert!((soft_clip(0.2) - 0.2).abs() < 1e-6);
    }
}
