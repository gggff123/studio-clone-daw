use crate::project::InstrumentSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waveform {
    Sine,
    Saw,
    Square,
    Triangle,
    Noise,
}

impl Waveform {
    pub fn parse(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "sine" | "sin" => Waveform::Sine,
            "square" | "pulse" => Waveform::Square,
            "triangle" | "tri" => Waveform::Triangle,
            "noise" => Waveform::Noise,
            _ => Waveform::Saw,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SynthPreset {
    pub wave1: Waveform,
    pub wave2: Waveform,
    pub detune_cents: f32,
    pub osc_mix: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub lfo_rate_hz: f32,
    pub lfo_depth: f32,
    pub lfo_target: LfoTarget,
    pub gain_db: f32,
    pub polyphony: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LfoTarget {
    Pitch,
    Filter,
    Amplitude,
    Off,
}

impl SynthPreset {
    pub fn from_settings(settings: &InstrumentSettings) -> Self {
        let lfo_target = match settings.lfo_target.to_ascii_lowercase().as_str() {
            "filter" => LfoTarget::Filter,
            "amplitude" | "amp" => LfoTarget::Amplitude,
            "off" | "none" => LfoTarget::Off,
            _ => LfoTarget::Pitch,
        };
        Self {
            wave1: Waveform::parse(&settings.wave1),
            wave2: Waveform::parse(&settings.wave2),
            detune_cents: settings.detune_cents.clamp(-1200.0, 1200.0),
            osc_mix: settings.osc_mix.clamp(0.0, 1.0),
            attack: settings.attack.max(0.0005),
            decay: settings.decay.max(0.001),
            sustain: settings.sustain.clamp(0.0, 1.0),
            release: settings.release.max(0.001),
            cutoff_hz: settings.cutoff_hz.clamp(30.0, 20_000.0),
            resonance: settings.resonance.clamp(0.0, 0.95),
            lfo_rate_hz: settings.lfo_rate_hz.clamp(0.01, 30.0),
            lfo_depth: settings.lfo_depth.clamp(0.0, 1.0),
            lfo_target,
            gain_db: settings.gain_db.clamp(-48.0, 12.0),
            polyphony: settings.polyphony.clamp(1, 64) as usize,
        }
    }
}

impl Default for SynthPreset {
    fn default() -> Self {
        Self::from_settings(&InstrumentSettings::default())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnvStage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Debug)]
struct Voice {
    note: u8,
    velocity: f32,
    active: bool,
    stage: EnvStage,
    env: f32,
    release_step: f32,
    phase1: f32,
    phase2: f32,
    lfo_phase: f32,
    filter_ic1: f32,
    filter_ic2: f32,
    age: u64,
    held: bool,
    noise_state: u32,
}

impl Voice {
    fn new() -> Self {
        Self {
            note: 60,
            velocity: 0.0,
            active: false,
            stage: EnvStage::Idle,
            env: 0.0,
            release_step: 0.0,
            phase1: 0.0,
            phase2: 0.0,
            lfo_phase: 0.0,
            filter_ic1: 0.0,
            filter_ic2: 0.0,
            age: 0,
            held: false,
            noise_state: 0x1234_5678,
        }
    }

    fn note_on(&mut self, note: u8, velocity: u8, age: u64) {
        self.note = note;
        self.velocity = (velocity as f32 / 127.0).clamp(0.0, 1.0);
        self.active = true;
        self.held = true;
        self.stage = EnvStage::Attack;
        self.env = 0.0;
        self.phase1 = 0.0;
        self.phase2 = 0.0;
        self.lfo_phase = 0.0;
        self.filter_ic1 = 0.0;
        self.filter_ic2 = 0.0;
        self.age = age;
    }

    fn note_off(&mut self) {
        self.held = false;
        if self.active && self.stage != EnvStage::Release {
            self.stage = EnvStage::Release;
        }
    }

    fn next_noise(&mut self) -> f32 {
        self.noise_state ^= self.noise_state << 13;
        self.noise_state ^= self.noise_state >> 17;
        self.noise_state ^= self.noise_state << 5;
        (self.noise_state as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn next_sample(&mut self, preset: &SynthPreset, sample_rate: f32, bend_factor: f32) -> f32 {
        if !self.active {
            return 0.0;
        }
        let base_freq =
            440.0 * 2f32.powf((self.note as f32 - 69.0) / 12.0) * bend_factor;
        let lfo = (self.lfo_phase * std::f32::consts::TAU).sin();

        // Envelope
        match self.stage {
            EnvStage::Idle => return 0.0,
            EnvStage::Attack => {
                self.env += 1.0 / (preset.attack * sample_rate).max(1.0);
                if self.env >= 1.0 {
                    self.env = 1.0;
                    self.stage = EnvStage::Decay;
                }
            }
            EnvStage::Decay => {
                let decrement = (1.0 - preset.sustain)
                    / (preset.decay * sample_rate).max(1.0);
                self.env -= decrement;
                if self.env <= preset.sustain {
                    self.env = preset.sustain;
                    self.stage = EnvStage::Sustain;
                }
            }
            EnvStage::Sustain => {
                self.env = preset.sustain;
            }
            EnvStage::Release => {
                self.env -= self.release_step.max(1.0 / (preset.release * sample_rate).max(1.0));
                if self.env <= 0.000_01 {
                    self.env = 0.0;
                    self.active = false;
                    self.stage = EnvStage::Idle;
                    return 0.0;
                }
            }
        }

        let pitch_mod = if preset.lfo_target == LfoTarget::Pitch {
            lfo * preset.lfo_depth * 0.6
        } else {
            0.0
        };
        let freq1 = base_freq * 2f32.powf(pitch_mod / 12.0);
        let freq2 = freq1 * 2f32.powf(preset.detune_cents / 1200.0);

        self.phase1 += freq1 / sample_rate;
        if self.phase1 >= 1.0 {
            self.phase1 -= 1.0;
        }
        self.phase2 += freq2 / sample_rate;
        if self.phase2 >= 1.0 {
            self.phase2 -= 1.0;
        }
        self.lfo_phase += preset.lfo_rate_hz / sample_rate;
        if self.lfo_phase >= 1.0 {
            self.lfo_phase -= 1.0;
        }

        let osc1 = if preset.wave1 == Waveform::Noise {
            self.next_noise()
        } else {
            waveform_sample(preset.wave1, self.phase1, freq1, sample_rate)
        };
        let osc2 = if preset.osc_mix > 0.0 {
            if preset.wave2 == Waveform::Noise {
                self.next_noise()
            } else {
                waveform_sample(preset.wave2, self.phase2, freq2, sample_rate)
            }
        } else {
            0.0
        };
        let mut sample = osc1 * (1.0 - preset.osc_mix) + osc2 * preset.osc_mix;

        // TPT state-variable low-pass with resonance.
        let cutoff_mod = if preset.lfo_target == LfoTarget::Filter {
            lfo * preset.lfo_depth * 6_000.0
        } else {
            0.0
        };
        let cutoff = (preset.cutoff_hz + cutoff_mod).clamp(20.0, sample_rate * 0.45);
        let g = (std::f32::consts::PI * cutoff / sample_rate).tan();
        let k = 1.6 - 1.55 * preset.resonance;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = sample - self.filter_ic2;
        let v1 = a1 * self.filter_ic1 + a2 * v3;
        let v2 = self.filter_ic2 + a2 * self.filter_ic1 + a3 * v3;
        self.filter_ic1 = 2.0 * v1 - self.filter_ic1;
        self.filter_ic2 = 2.0 * v2 - self.filter_ic2;
        sample = v2;

        let amp_mod = if preset.lfo_target == LfoTarget::Amplitude {
            1.0 - preset.lfo_depth * 0.5 * (1.0 - lfo)
        } else {
            1.0
        };
        let gain = 10f32.powf(preset.gain_db / 20.0);
        sample * self.env * self.velocity * amp_mod * gain
    }
}

fn waveform_sample(wave: Waveform, phase: f32, freq: f32, sample_rate: f32) -> f32 {
    match wave {
        Waveform::Sine => (phase * std::f32::consts::TAU).sin(),
        Waveform::Saw => {
            let dt = freq / sample_rate;
            2.0 * phase - 1.0 - poly_blep(phase, dt)
        }
        Waveform::Square => {
            let dt = freq / sample_rate;
            let mut value = if phase < 0.5 { 1.0 } else { -1.0 };
            value += poly_blep(phase, dt);
            value -= poly_blep((phase + 0.5) % 1.0, dt);
            value
        }
        Waveform::Triangle => 4.0 * (phase - 0.5).abs() - 1.0,
        Waveform::Noise => {
            // Deterministic pseudo-noise based on phase stepping.
            let x = (phase * 16_777_216.0) as u32;
            let x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x as f32 / u32::MAX as f32) * 2.0 - 1.0
        }
    }
}

fn poly_blep(t: f32, dt: f32) -> f32 {
    let dt = dt.clamp(0.0, 0.5);
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[derive(Clone, Debug)]
pub struct Synth {
    voices: Vec<Voice>,
    preset: SynthPreset,
    sample_rate: f32,
    age: u64,
    sustain_pedal: bool,
    pitch_bend: f32,
}

impl Synth {
    pub fn new(sample_rate: u32, settings: &InstrumentSettings) -> Self {
        let preset = SynthPreset::from_settings(settings);
        let voices = (0..preset.polyphony.max(1)).map(|_| Voice::new()).collect();
        Self {
            voices,
            preset,
            sample_rate: sample_rate as f32,
            age: 0,
            sustain_pedal: false,
            pitch_bend: 0.0,
        }
    }

    pub fn update_settings(&mut self, settings: &InstrumentSettings) {
        self.preset = SynthPreset::from_settings(settings);
        while self.voices.len() < self.preset.polyphony {
            self.voices.push(Voice::new());
        }
        if self.voices.len() > self.preset.polyphony * 2 {
            self.voices.truncate(self.preset.polyphony.max(1));
        }
    }

    pub fn note_on(&mut self, note: u8, velocity: u8) {
        self.age = self.age.wrapping_add(1);
        if let Some(voice) = self
            .voices
            .iter_mut()
            .find(|v| !v.active || v.note == note && v.held)
        {
            voice.note_on(note, velocity, self.age);
            return;
        }
        // Steal the oldest voice.
        if let Some(voice) = self.voices.iter_mut().min_by_key(|v| v.age) {
            voice.note_on(note, velocity, self.age);
        }
    }

    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.note == note && voice.active {
                if self.sustain_pedal {
                    voice.held = false;
                } else {
                    voice.note_off();
                }
            }
        }
    }

    pub fn set_sustain_pedal(&mut self, down: bool) {
        self.sustain_pedal = down;
        if !down {
            for voice in &mut self.voices {
                if voice.active && !voice.held {
                    voice.note_off();
                }
            }
        }
    }

    pub fn set_pitch_bend(&mut self, normalized: f32) {
        self.pitch_bend = normalized.clamp(-1.0, 1.0);
    }

    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            voice.note_off();
        }
    }

    pub fn panic(&mut self) {
        for voice in &mut self.voices {
            voice.active = false;
            voice.stage = EnvStage::Idle;
            voice.env = 0.0;
            voice.held = false;
        }
        self.sustain_pedal = false;
    }

    pub fn active_voice_count(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Add synthesized mono samples into the supplied buffer.
    pub fn render_add(&mut self, output: &mut [f32]) {
        let preset = self.preset.clone();
        let sample_rate = self.sample_rate;
        let bend_semitones = self.pitch_bend * 2.0;
        let bend_factor = 2f32.powf(bend_semitones / 12.0);
        for sample in output.iter_mut() {
            let mut sum = 0.0;
            for voice in &mut self.voices {
                if voice.active {
                    sum += voice.next_sample(&preset, sample_rate, bend_factor);
                }
            }
            *sample += sum;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> InstrumentSettings {
        InstrumentSettings {
            attack: 0.001,
            decay: 0.01,
            sustain: 0.8,
            release: 0.02,
            polyphony: 8,
            ..Default::default()
        }
    }

    #[test]
    fn note_on_produces_signal() {
        let mut synth = Synth::new(48_000, &settings());
        synth.note_on(60, 100);
        let mut buffer = vec![0.0; 4_800];
        synth.render_add(&mut buffer);
        assert!(buffer.iter().any(|s| s.abs() > 0.001));
        assert!(buffer.iter().all(|s| s.is_finite()));
        assert_eq!(synth.active_voice_count(), 1);
    }

    #[test]
    fn release_eventually_silences_voice() {
        let mut synth = Synth::new(48_000, &settings());
        synth.note_on(60, 100);
        let mut buffer = vec![0.0; 480];
        synth.render_add(&mut buffer);
        synth.note_off(60);
        let mut tail = vec![0.0; 48_000];
        synth.render_add(&mut tail);
        assert_eq!(synth.active_voice_count(), 0);
        // The release itself is audible at the start, then decays to silence.
        assert!(tail[..500].iter().any(|s| s.abs() > 0.001));
        assert!(tail[2_000..].iter().all(|s| s.abs() < 0.01));
    }

    #[test]
    fn polyphony_handles_chords() {
        let mut synth = Synth::new(48_000, &settings());
        for note in [60, 64, 67, 72] {
            synth.note_on(note, 90);
        }
        assert_eq!(synth.active_voice_count(), 4);
        let mut buffer = vec![0.0; 960];
        synth.render_add(&mut buffer);
        assert!(buffer.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn sustain_pedal_holds_notes() {
        let mut synth = Synth::new(48_000, &settings());
        synth.note_on(60, 100);
        synth.set_sustain_pedal(true);
        synth.note_off(60);
        let mut buffer = vec![0.0; 980];
        synth.render_add(&mut buffer);
        assert_eq!(synth.active_voice_count(), 1);
        synth.set_sustain_pedal(false);
        let mut tail = vec![0.0; 48_000];
        synth.render_add(&mut tail);
        assert_eq!(synth.active_voice_count(), 0);
    }

    #[test]
    fn all_waveforms_are_bounded() {
        for wave in ["sine", "saw", "square", "triangle", "noise"] {
            let mut s = settings();
            s.wave1 = wave.into();
            s.wave2 = wave.into();
            s.cutoff_hz = 8_000.0;
            let mut synth = Synth::new(48_000, &s);
            synth.note_on(69, 127);
            let mut buffer = vec![0.0; 4_800];
            synth.render_add(&mut buffer);
            assert!(
                buffer.iter().all(|v| v.is_finite() && v.abs() < 4.0),
                "wave {wave} produced invalid output"
            );
        }
    }
}
