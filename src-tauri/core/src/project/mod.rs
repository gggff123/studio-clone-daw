pub mod serialization;
pub mod time;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FORMAT_VERSION: u32 = 1;
pub const DEFAULT_PPQ: u32 = 960;

fn default_format_version() -> u32 {
    FORMAT_VERSION
}
fn default_ppq() -> u32 {
    DEFAULT_PPQ
}
fn default_tempo() -> f64 {
    120.0
}
fn default_sample_rate() -> u32 {
    48_000
}
fn default_track_height() -> f32 {
    72.0
}
fn default_master_output() -> String {
    "master".into()
}
fn default_time_signature() -> TimeSignature {
    TimeSignature {
        numerator: 4,
        denominator: 4,
    }
}
fn default_loop_region() -> LoopRegion {
    LoopRegion {
        enabled: false,
        start_ticks: 0,
        end_ticks: DEFAULT_PPQ as u64 * 16,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TrackKind {
    Audio,
    Midi,
    Instrument,
    Group,
    Fx,
    Marker,
    Folder,
}

impl Default for TrackKind {
    fn default() -> Self {
        TrackKind::Audio
    }
}

impl TrackKind {
    pub fn is_bus(&self) -> bool {
        matches!(self, TrackKind::Group | TrackKind::Fx)
    }

    pub fn carries_audio(&self) -> bool {
        matches!(
            self,
            TrackKind::Audio | TrackKind::Midi | TrackKind::Instrument | TrackKind::Group | TrackKind::Fx
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeSignature {
    pub numerator: u32,
    pub denominator: u32,
}

impl Default for TimeSignature {
    fn default() -> Self {
        default_time_signature()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LoopRegion {
    pub enabled: bool,
    pub start_ticks: u64,
    pub end_ticks: u64,
}

impl Default for LoopRegion {
    fn default() -> Self {
        default_loop_region()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Marker {
    pub id: String,
    pub name: String,
    pub ticks: u64,
    pub color: String,
}

impl Default for Marker {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Marker".into(),
            ticks: 0,
            color: "#c9a227".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MidiNote {
    pub id: String,
    pub pitch: u8,
    pub start_ticks: u64,
    pub duration_ticks: u64,
    pub velocity: u8,
    pub channel: u8,
}

impl Default for MidiNote {
    fn default() -> Self {
        Self {
            id: String::new(),
            pitch: 60,
            start_ticks: 0,
            duration_ticks: DEFAULT_PPQ as u64 / 4,
            velocity: 100,
            channel: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MidiPart {
    pub id: String,
    pub name: String,
    pub start_ticks: u64,
    pub duration_ticks: u64,
    pub color: String,
    pub notes: Vec<MidiNote>,
}

impl Default for MidiPart {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "MIDI Part".into(),
            start_ticks: 0,
            duration_ticks: DEFAULT_PPQ as u64 * 4,
            color: "#6f86b8".into(),
            notes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioClip {
    pub id: String,
    pub name: String,
    pub media_path: String,
    pub start_ticks: u64,
    pub offset_ticks: u64,
    pub duration_ticks: u64,
    pub gain_db: f32,
    pub fade_in_ticks: u64,
    pub fade_out_ticks: u64,
    pub color: String,
    pub media_sample_rate: u32,
}

impl Default for AudioClip {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Audio".into(),
            media_path: String::new(),
            start_ticks: 0,
            offset_ticks: 0,
            duration_ticks: DEFAULT_PPQ as u64 * 4,
            gain_db: 0.0,
            fade_in_ticks: 0,
            fade_out_ticks: 0,
            color: "#4f8fce".into(),
            media_sample_rate: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Send {
    pub id: String,
    pub target_track_id: String,
    pub level_db: f32,
    pub pre_fader: bool,
    pub enabled: bool,
}

impl Default for Send {
    fn default() -> Self {
        Self {
            id: String::new(),
            target_track_id: "master".into(),
            level_db: -12.0,
            pre_fader: false,
            enabled: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct InstrumentSettings {
    pub preset: String,
    pub wave1: String,
    pub wave2: String,
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
    pub lfo_target: String,
    pub gain_db: f32,
    pub polyphony: u32,
}

impl Default for InstrumentSettings {
    fn default() -> Self {
        Self {
            preset: "Init Saw".into(),
            wave1: "saw".into(),
            wave2: "saw".into(),
            detune_cents: 7.0,
            osc_mix: 0.35,
            attack: 0.008,
            decay: 0.18,
            sustain: 0.72,
            release: 0.28,
            cutoff_hz: 3200.0,
            resonance: 0.18,
            lfo_rate_hz: 5.0,
            lfo_depth: 0.0,
            lfo_target: "pitch".into(),
            gain_db: -8.0,
            polyphony: 16,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EffectKind {
    Gain,
    Pan,
    Eq3,
    Parametric,
    Compressor,
    Limiter,
    NoiseGate,
    Delay,
    Reverb,
    Chorus,
}

impl Default for EffectKind {
    fn default() -> Self {
        EffectKind::Gain
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct InsertEffect {
    pub id: String,
    pub kind: EffectKind,
    pub enabled: bool,
    pub params: BTreeMap<String, f64>,
}

impl Default for InsertEffect {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: EffectKind::Gain,
            enabled: true,
            params: BTreeMap::new(),
        }
    }
}

impl InsertEffect {
    pub fn param(&self, key: &str, fallback: f64) -> f64 {
        self.params.get(key).copied().unwrap_or(fallback)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub color: String,
    pub volume_db: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub record_arm: bool,
    pub height: f32,
    pub clips: Vec<AudioClip>,
    pub parts: Vec<MidiPart>,
    pub instrument: Option<InstrumentSettings>,
    pub inserts: Vec<InsertEffect>,
    pub sends: Vec<Send>,
    pub output: String,
    pub input: String,
}

impl Default for Track {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Track".into(),
            kind: TrackKind::Audio,
            color: "#4f8fce".into(),
            volume_db: 0.0,
            pan: 0.0,
            mute: false,
            solo: false,
            record_arm: false,
            height: default_track_height(),
            clips: Vec::new(),
            parts: Vec::new(),
            instrument: None,
            inserts: Vec::new(),
            sends: Vec::new(),
            output: default_master_output(),
            input: "Stereo In".into(),
        }
    }
}

impl Track {
    pub fn new(kind: TrackKind, name: impl Into<String>, color: impl Into<String>) -> Self {
        let kind_for_instrument = kind.clone();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            kind,
            color: color.into(),
            instrument: if kind_for_instrument == TrackKind::Instrument {
                Some(InstrumentSettings::default())
            } else {
                None
            },
            ..Default::default()
        }
    }

    pub fn is_audible(&self, any_solo: bool) -> bool {
        !self.mute && (!any_solo || self.solo)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MasterBus {
    pub volume_db: f32,
    pub pan: f32,
    pub inserts: Vec<InsertEffect>,
    pub limiter: bool,
}

impl Default for MasterBus {
    fn default() -> Self {
        Self {
            volume_db: 0.0,
            pan: 0.0,
            inserts: Vec::new(),
            limiter: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub format_version: u32,
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub tempo: f64,
    pub time_signature: TimeSignature,
    pub ppq: u32,
    pub tracks: Vec<Track>,
    pub master: MasterBus,
    pub markers: Vec<Marker>,
    pub loop_region: LoopRegion,
    pub metronome: bool,
    pub created_at: String,
    pub modified_at: String,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            format_version: default_format_version(),
            id: uuid::Uuid::new_v4().to_string(),
            name: "Untitled Project".into(),
            sample_rate: default_sample_rate(),
            tempo: default_tempo(),
            time_signature: default_time_signature(),
            ppq: default_ppq(),
            tracks: Vec::new(),
            master: MasterBus::default(),
            markers: Vec::new(),
            loop_region: default_loop_region(),
            metronome: false,
            created_at: String::new(),
            modified_at: String::new(),
        }
    }
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    pub fn find_track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn find_track_mut(&mut self, id: &str) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    pub fn any_solo(&self) -> bool {
        self.tracks.iter().any(|t| t.solo)
    }

    pub fn end_ticks(&self) -> u64 {
        let mut end = self.loop_region.end_ticks;
        for track in &self.tracks {
            for clip in &track.clips {
                end = end.max(clip.start_ticks + clip.duration_ticks);
            }
            for part in &track.parts {
                end = end.max(part.start_ticks + part.duration_ticks);
            }
        }
        end
    }

    pub fn sanitize(&mut self) {
        self.format_version = FORMAT_VERSION;
        if self.ppq == 0 {
            self.ppq = DEFAULT_PPQ;
        }
        if !self.tempo.is_finite() {
            self.tempo = 120.0;
        }
        self.tempo = self.tempo.clamp(20.0, 300.0);
        if self.sample_rate < 8_000 {
            self.sample_rate = 48_000;
        }
        if self.time_signature.numerator == 0 {
            self.time_signature.numerator = 4;
        }
        if self.time_signature.denominator == 0 {
            self.time_signature.denominator = 4;
        }
        self.loop_region.end_ticks = self
            .loop_region
            .end_ticks
            .max(self.loop_region.start_ticks.saturating_add(1));
        for track in &mut self.tracks {
            if track.height < 32.0 {
                track.height = 72.0;
            }
            track.volume_db = track.volume_db.clamp(-96.0, 12.0);
            track.pan = track.pan.clamp(-1.0, 1.0);
            for clip in &mut track.clips {
                clip.gain_db = clip.gain_db.clamp(-96.0, 24.0);
                clip.duration_ticks = clip.duration_ticks.max(1);
                clip.fade_in_ticks = clip.fade_in_ticks.min(clip.duration_ticks);
                clip.fade_out_ticks = clip.fade_out_ticks.min(clip.duration_ticks);
            }
            for part in &mut track.parts {
                part.duration_ticks = part.duration_ticks.max(1);
                for note in &mut part.notes {
                    note.pitch = note.pitch.min(127);
                    note.velocity = note.velocity.clamp(1, 127);
                    note.duration_ticks = note.duration_ticks.max(1);
                }
            }
            if let Some(inst) = &mut track.instrument {
                inst.cutoff_hz = inst.cutoff_hz.clamp(30.0, 20_000.0);
                inst.resonance = inst.resonance.clamp(0.0, 0.98);
                inst.polyphony = inst.polyphony.clamp(1, 64);
                inst.attack = inst.attack.clamp(0.0005, 10.0);
                inst.decay = inst.decay.clamp(0.001, 10.0);
                inst.release = inst.release.clamp(0.001, 20.0);
                inst.sustain = inst.sustain.clamp(0.0, 1.0);
            }
            for insert in &mut track.inserts {
                if insert.id.is_empty() {
                    insert.id = uuid::Uuid::new_v4().to_string();
                }
            }
        }
        for insert in &mut self.master.inserts {
            if insert.id.is_empty() {
                insert.id = uuid::Uuid::new_v4().to_string();
            }
        }
    }
}
