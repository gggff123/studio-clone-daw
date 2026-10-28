//! Project-to-render-graph conversion and the shared native mixing engine.
//!
//! The renderer is used both by the real-time CPAL callback and by offline WAV
//! export. Only project snapshots are shared with the audio path; the frontend
//! never supplies samples or locks used by the callback.

use crate::audio::asset::{AssetCache, AudioAsset};
use crate::audio::effects::{soft_clip, EffectState};
use crate::instruments::synthesizer::Synth;
use crate::project::time::{db_to_gain, ticks_to_frames, ticks_to_seconds};
use crate::project::{InsertEffect, InstrumentSettings, Project, TrackKind};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

pub const MAX_BLOCK_FRAMES: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MidiEventKind {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    Sustain(bool),
    PitchBend(f32),
}

#[derive(Clone, Copy, Debug)]
pub struct MidiEvent {
    pub frame: u64,
    pub kind: MidiEventKind,
}

#[derive(Debug)]
pub struct RenderClip {
    pub id: String,
    pub asset: Arc<AudioAsset>,
    pub start_frame: u64,
    pub end_frame: u64,
    pub source_start_frame: f64,
    pub gain: f32,
    pub fade_in_frames: u64,
    pub fade_out_frames: u64,
}

#[derive(Debug)]
pub struct RenderTrack {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub active: bool,
    pub is_bus: bool,
    pub parent: Option<usize>,
    pub gain: f32,
    pub pan_l: f32,
    pub pan_r: f32,
    pub clips: Vec<RenderClip>,
    pub midi_events: Vec<MidiEvent>,
    pub instrument: Option<InstrumentSettings>,
    pub inserts: Vec<InsertEffect>,
}

#[derive(Debug)]
pub struct MasterRender {
    pub gain: f32,
    pub pan_l: f32,
    pub pan_r: f32,
    pub inserts: Vec<InsertEffect>,
    pub limiter: bool,
}

#[derive(Debug)]
pub struct MeterBank {
    pub ids: Vec<String>,
    pub peaks: Vec<AtomicU32>,
}

impl MeterBank {
    pub fn new(ids: Vec<String>) -> Self {
        let peaks = (0..ids.len()).map(|_| AtomicU32::new(0)).collect();
        Self { ids, peaks }
    }

    pub fn store(&self, index: usize, value: f32) {
        if let Some(peak) = self.peaks.get(index) {
            peak.store(value.max(0.0).to_bits(), Ordering::Relaxed);
        }
    }

    pub fn reset(&self) {
        for peak in &self.peaks {
            peak.store(0, Ordering::Relaxed);
        }
    }

    pub fn read(&self) -> Vec<f32> {
        self.peaks
            .iter()
            .map(|p| f32::from_bits(p.load(Ordering::Relaxed)))
            .collect()
    }
}

#[derive(Debug)]
pub struct RenderGraph {
    pub generation: u64,
    pub sample_rate: u32,
    pub tempo: f64,
    pub ppq: u32,
    pub time_signature_numerator: u32,
    pub tracks: Vec<RenderTrack>,
    /// Children before parents. Every track is processed exactly once.
    pub order: Vec<usize>,
    pub master: MasterRender,
    pub end_frame: u64,
    pub loop_start_frame: u64,
    pub loop_end_frame: u64,
    pub metronome: bool,
    pub meters: Arc<MeterBank>,
}

pub struct GraphBuildResult {
    pub graph: RenderGraph,
    pub missing_media: Vec<String>,
}

fn pan_gains(pan: f32) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);
    let left = if pan <= 0.0 { 1.0 } else { 1.0 - pan };
    let right = if pan >= 0.0 { 1.0 } else { 1.0 + pan };
    (left, right)
}

fn track_inserts(track: &crate::project::Track) -> Vec<InsertEffect> {
    track
        .inserts
        .iter()
        .filter(|fx| fx.enabled)
        .cloned()
        .collect()
}

pub fn build_render_graph(
    project: &Project,
    sample_rate: u32,
    cache: &mut AssetCache,
    generation: u64,
    existing_meters: Option<Arc<MeterBank>>,
) -> GraphBuildResult {
    let sample_rate = if sample_rate == 0 { 48_000 } else { sample_rate };
    let tempo = project.tempo.clamp(20.0, 300.0);
    let ppq = project.ppq.max(1);
    let any_solo = project.any_solo();
    let mut missing_media = Vec::new();

    let mut tracks: Vec<RenderTrack> = Vec::with_capacity(project.tracks.len());
    for track in &project.tracks {
        let mut clips = Vec::new();
        for clip in &track.clips {
            if clip.media_path.trim().is_empty() {
                continue;
            }
            let path = std::path::PathBuf::from(&clip.media_path);
            let asset = match cache.load(&path) {
                Ok(asset) => asset,
                Err(err) => {
                    missing_media.push(format!("{} ({err})", clip.media_path));
                    continue;
                }
            };
            let start_frame = ticks_to_frames(clip.start_ticks, tempo, ppq, sample_rate);
            let duration_frames = ticks_to_frames(
                clip.duration_ticks.max(1),
                tempo,
                ppq,
                sample_rate,
            )
            .max(1);
            let end_frame = start_frame + duration_frames;
            let source_start_frame =
                ticks_to_seconds(clip.offset_ticks, tempo, ppq) * asset.sample_rate as f64;
            let fade_in_frames = ticks_to_frames(clip.fade_in_ticks, tempo, ppq, sample_rate)
                .min(duration_frames);
            let fade_out_frames = ticks_to_frames(clip.fade_out_ticks, tempo, ppq, sample_rate)
                .min(duration_frames);
            clips.push(RenderClip {
                id: clip.id.clone(),
                asset,
                start_frame,
                end_frame,
                source_start_frame,
                gain: db_to_gain(clip.gain_db),
                fade_in_frames,
                fade_out_frames,
            });
        }

        let mut midi_events = Vec::new();
        if matches!(track.kind, TrackKind::Instrument | TrackKind::Midi) {
            for part in &track.parts {
                for note in &part.notes {
                    let start_ticks = part.start_ticks.saturating_add(note.start_ticks);
                    let start = ticks_to_frames(start_ticks, tempo, ppq, sample_rate);
                    let end = ticks_to_frames(
                        start_ticks.saturating_add(note.duration_ticks.max(1)),
                        tempo,
                        ppq,
                        sample_rate,
                    );
                    midi_events.push(MidiEvent {
                        frame: start,
                        kind: MidiEventKind::NoteOn {
                            note: note.pitch.min(127),
                            velocity: note.velocity.clamp(1, 127),
                        },
                    });
                    midi_events.push(MidiEvent {
                        frame: end,
                        kind: MidiEventKind::NoteOff {
                            note: note.pitch.min(127),
                        },
                    });
                }
            }
            midi_events.sort_by_key(|e| e.frame);
        }

        let (pan_l, pan_r) = pan_gains(track.pan);
        tracks.push(RenderTrack {
            id: track.id.clone(),
            name: track.name.clone(),
            kind: track.kind.clone(),
            active: track.is_audible(any_solo),
            is_bus: track.kind.is_bus(),
            parent: None,
            gain: db_to_gain(track.volume_db),
            pan_l,
            pan_r,
            clips,
            midi_events,
            instrument: track.instrument.clone(),
            inserts: track_inserts(track),
        });
    }

    // One-level (or chained) group/FX routing. Invalid or cyclic destinations
    // fall back to the master bus rather than risking feedback.
    let id_map: HashMap<String, usize> = project
        .tracks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.clone(), i))
        .collect();
    for (index, track) in project.tracks.iter().enumerate() {
        if track.output == "master" || track.output.is_empty() {
            continue;
        }
        if let Some(&target) = id_map.get(&track.output) {
            if target != index
                && project
                    .tracks
                    .get(target)
                    .map(|t| t.kind.is_bus())
                    .unwrap_or(false)
            {
                tracks[index].parent = Some(target);
            }
        }
    }
    // Remove cycles by walking each parent chain.
    for index in 0..tracks.len() {
        let mut cursor = tracks[index].parent;
        let mut steps = 0usize;
        while let Some(parent) = cursor {
            if parent == index || steps > tracks.len() {
                tracks[index].parent = None;
                break;
            }
            cursor = tracks[parent].parent;
            steps += 1;
        }
    }

    // Topological order: children before their group/FX bus parent.
    let mut child_counts = vec![0usize; tracks.len()];
    for parent in tracks.iter().filter_map(|t| t.parent) {
        child_counts[parent] += 1;
    }
    let mut queue: Vec<usize> = (0..tracks.len())
        .filter(|i| child_counts[*i] == 0)
        .collect();
    let mut order = Vec::with_capacity(tracks.len());
    let mut head = 0;
    while head < queue.len() {
        let node = queue[head];
        head += 1;
        order.push(node);
        if let Some(parent) = tracks[node].parent {
            child_counts[parent] -= 1;
            if child_counts[parent] == 0 {
                queue.push(parent);
            }
        }
    }
    if order.len() < tracks.len() {
        for i in 0..tracks.len() {
            if !order.contains(&i) {
                tracks[i].parent = None;
                order.push(i);
            }
        }
    }

    let end_ticks = project.end_ticks();
    let end_frame = ticks_to_frames(end_ticks, tempo, ppq, sample_rate)
        .saturating_add(ticks_to_frames(ppq as u64 * 8, tempo, ppq, sample_rate));
    let loop_start_frame = ticks_to_frames(project.loop_region.start_ticks, tempo, ppq, sample_rate);
    let loop_end_frame = ticks_to_frames(
        project.loop_region.end_ticks.max(project.loop_region.start_ticks + ppq as u64),
        tempo,
        ppq,
        sample_rate,
    );
    let (master_pan_l, master_pan_r) = pan_gains(project.master.pan);

    let ids: Vec<String> = tracks
        .iter()
        .map(|t| t.id.clone())
        .chain(std::iter::once("master".to_string()))
        .collect();
    let meters = match existing_meters {
        Some(bank) if bank.ids == ids => bank,
        _ => Arc::new(MeterBank::new(ids)),
    };

    let graph = RenderGraph {
        generation,
        sample_rate,
        tempo,
        ppq,
        time_signature_numerator: project.time_signature.numerator.max(1),
        tracks,
        order,
        master: MasterRender {
            gain: db_to_gain(project.master.volume_db),
            pan_l: master_pan_l,
            pan_r: master_pan_r,
            inserts: project.master.inserts.clone(),
            limiter: project.master.limiter,
        },
        end_frame,
        loop_start_frame,
        loop_end_frame,
        metronome: project.metronome,
        meters,
    };

    GraphBuildResult {
        graph,
        missing_media,
    }
}

struct TrackRuntime {
    synth: Option<Synth>,
    cursor: usize,
    effects: Vec<EffectState>,
}

pub struct RenderRuntime {
    sample_rate: u32,
    generation: Option<u64>,
    synth_mono: Vec<f32>,
    track_l: Vec<f32>,
    track_r: Vec<f32>,
    bus_l: HashMap<usize, Vec<f32>>,
    bus_r: HashMap<usize, Vec<f32>>,
    pub master_l: Vec<f32>,
    pub master_r: Vec<f32>,
    meter_peaks: Vec<f32>,
    tracks: HashMap<String, TrackRuntime>,
    master_effects: Vec<EffectState>,
    last_reset_seq: u64,
}

impl Default for RenderRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderRuntime {
    pub fn new() -> Self {
        Self {
            sample_rate: 0,
            generation: None,
            synth_mono: vec![0.0; MAX_BLOCK_FRAMES],
            track_l: vec![0.0; MAX_BLOCK_FRAMES],
            track_r: vec![0.0; MAX_BLOCK_FRAMES],
            bus_l: HashMap::new(),
            bus_r: HashMap::new(),
            master_l: vec![0.0; MAX_BLOCK_FRAMES],
            master_r: vec![0.0; MAX_BLOCK_FRAMES],
            meter_peaks: Vec::new(),
            tracks: HashMap::new(),
            master_effects: Vec::new(),
            last_reset_seq: u64::MAX,
        }
    }

    fn align_effects(effects: &mut Vec<EffectState>, inserts: &[InsertEffect], sample_rate: u32) {
        effects.truncate(inserts.len());
        while effects.len() < inserts.len() {
            let kind = inserts[effects.len()].kind.clone();
            effects.push(EffectState::new(&kind, sample_rate));
        }
        for (state, insert) in effects.iter_mut().zip(inserts.iter()) {
            if !state.matches(&insert.kind) {
                *state = EffectState::new(&insert.kind, sample_rate);
            }
        }
    }

    fn sync(
        &mut self,
        graph: &RenderGraph,
        start_frame: u64,
        reset_seq: u64,
    ) {
        let force_seek = self.last_reset_seq != reset_seq || self.generation != Some(graph.generation);
        if self.sample_rate != graph.sample_rate {
            self.sample_rate = graph.sample_rate;
        }
        let active_ids: std::collections::HashSet<&str> =
            graph.tracks.iter().map(|t| t.id.as_str()).collect();
        self.tracks.retain(|id, _| active_ids.contains(id.as_str()));
        if self.meter_peaks.len() != graph.tracks.len() + 1 {
            self.meter_peaks = vec![0.0; graph.tracks.len() + 1];
        }

        for (index, track) in graph.tracks.iter().enumerate() {
            let entry = self
                .tracks
                .entry(track.id.clone())
                .or_insert_with(|| TrackRuntime {
                    synth: if track.instrument.is_some() {
                        Some(Synth::new(graph.sample_rate, track.instrument.as_ref().unwrap()))
                    } else {
                        None
                    },
                    cursor: 0,
                    effects: Vec::new(),
                });
            if track.instrument.is_some() {
                match &mut entry.synth {
                    Some(synth) => synth.update_settings(track.instrument.as_ref().unwrap()),
                    None => {
                        entry.synth = Some(Synth::new(
                            graph.sample_rate,
                            track.instrument.as_ref().unwrap(),
                        ))
                    }
                }
            } else {
                entry.synth = None;
            }
            Self::align_effects(&mut entry.effects, &track.inserts, graph.sample_rate);
            if force_seek || entry.cursor > track.midi_events.len() {
                entry.cursor = track
                    .midi_events
                    .partition_point(|event| event.frame < start_frame);
            }
            if track.is_bus {
                self.bus_l
                    .entry(index)
                    .or_insert_with(|| vec![0.0; MAX_BLOCK_FRAMES]);
                self.bus_r
                    .entry(index)
                    .or_insert_with(|| vec![0.0; MAX_BLOCK_FRAMES]);
            }
        }
        self.bus_l.retain(|index, _| *index < graph.tracks.len());
        self.bus_r.retain(|index, _| *index < graph.tracks.len());
        Self::align_effects(&mut self.master_effects, &graph.master.inserts, graph.sample_rate);
        if force_seek {
            for runtime in self.tracks.values_mut() {
                if let Some(synth) = &mut runtime.synth {
                    synth.panic();
                }
            }
            self.last_reset_seq = reset_seq;
        }
        self.generation = Some(graph.generation);
    }

    pub fn prepare(&mut self, graph: &RenderGraph, start_frame: u64, reset_seq: u64) {
        self.sync(graph, start_frame, reset_seq);
    }

    pub fn seek(&mut self, graph: &RenderGraph, start_frame: u64) {
        for (index, track) in graph.tracks.iter().enumerate() {
            if let Some(runtime) = self.tracks.get_mut(&track.id) {
                runtime.cursor = track
                    .midi_events
                    .partition_point(|event| event.frame < start_frame);
                if let Some(synth) = &mut runtime.synth {
                    synth.panic();
                }
            }
            let _ = index;
        }
    }

    pub fn note_on(&mut self, graph: &RenderGraph, track_id: &str, note: u8, velocity: u8) {
        if let Some(runtime) = self.tracks.get_mut(track_id) {
            if let Some(synth) = &mut runtime.synth {
                synth.note_on(note, velocity);
            }
        }
        let _ = graph;
    }

    pub fn note_off(&mut self, track_id: &str, note: u8) {
        if let Some(runtime) = self.tracks.get_mut(track_id) {
            if let Some(synth) = &mut runtime.synth {
                synth.note_off(note);
            }
        }
    }

    pub fn sustain(&mut self, track_id: &str, down: bool) {
        if let Some(runtime) = self.tracks.get_mut(track_id) {
            if let Some(synth) = &mut runtime.synth {
                synth.set_sustain_pedal(down);
            }
        }
    }

    pub fn pitch_bend(&mut self, track_id: &str, value: f32) {
        if let Some(runtime) = self.tracks.get_mut(track_id) {
            if let Some(synth) = &mut runtime.synth {
                synth.set_pitch_bend(value);
            }
        }
    }

    pub fn panic(&mut self) {
        for runtime in self.tracks.values_mut() {
            if let Some(synth) = &mut runtime.synth {
                synth.panic();
            }
        }
    }
}

fn render_clips(
    track: &RenderTrack,
    runtime: &mut RenderRuntime,
    start: u64,
    frames: usize,
) {
    let block_end = start + frames as u64;
    for clip in &track.clips {
        if clip.end_frame <= start || clip.start_frame >= block_end {
            continue;
        }
        let overlap_start = clip.start_frame.max(start);
        let overlap_end = clip.end_frame.min(block_end);
        let offset = (overlap_start - start) as usize;
        let count = (overlap_end - overlap_start) as usize;
        if count == 0 {
            continue;
        }
        let asset = &clip.asset;
        let asset_frames = asset.frame_count();
        if asset_frames == 0 {
            continue;
        }
        let step = asset.sample_rate as f64 / runtime.sample_rate as f64;
        let duration_frames = clip.end_frame.saturating_sub(clip.start_frame).max(1);
        let mut source = clip.source_start_frame
            + (overlap_start - clip.start_frame) as f64 * step;
        for i in 0..count {
            let local = (overlap_start - clip.start_frame) + i as u64;
            let fade_gain = {
                let fade_in = if clip.fade_in_frames > 0 {
                    (local as f32 / clip.fade_in_frames as f32).min(1.0)
                } else {
                    1.0
                };
                let fade_out = if clip.fade_out_frames > 0 {
                    let remaining = duration_frames.saturating_sub(local);
                    (remaining as f32 / clip.fade_out_frames as f32).min(1.0)
                } else {
                    1.0
                };
                fade_in * fade_out
            };
            let index = source.floor() as u64;
            let frac = (source - index as f64) as f32;
            let (l, r) = if index + 1 < asset_frames {
                let i0 = index as usize * 2;
                let i1 = i0 + 2;
                let l0 = asset.samples[i0];
                let r0 = asset.samples[i0 + 1];
                let l1 = asset.samples[i1];
                let r1 = asset.samples[i1 + 1];
                (l0 + (l1 - l0) * frac, r0 + (r1 - r0) * frac)
            } else if index < asset_frames {
                let i0 = index as usize * 2;
                (asset.samples[i0], asset.samples[i0 + 1])
            } else {
                (0.0, 0.0)
            };
            let gain = clip.gain * fade_gain;
            let target = offset + i;
            runtime.track_l[target] += l * gain;
            runtime.track_r[target] += r * gain;
            source += step;
        }
    }
}

/// Render one block into the runtime's master buffers.
pub fn render_block(
    graph: &RenderGraph,
    runtime: &mut RenderRuntime,
    start_frame: u64,
    frames: usize,
    playing: bool,
    reset_seq: u64,
) -> usize {
    let frames = frames.min(MAX_BLOCK_FRAMES);
    if frames == 0 {
        return 0;
    }
    runtime.sync(graph, start_frame, reset_seq);
    let meter_len = graph.tracks.len() + 1;
    if runtime.meter_peaks.len() != meter_len {
        runtime.meter_peaks.resize(meter_len, 0.0);
    }
    runtime.meter_peaks.iter_mut().for_each(|p| *p = 0.0);

    runtime.master_l[..frames].iter_mut().for_each(|s| *s = 0.0);
    runtime.master_r[..frames].iter_mut().for_each(|s| *s = 0.0);
    for bus in runtime.bus_l.values_mut() {
        bus[..frames].iter_mut().for_each(|s| *s = 0.0);
    }
    for bus in runtime.bus_r.values_mut() {
        bus[..frames].iter_mut().for_each(|s| *s = 0.0);
    }

    for &index in &graph.order {
        let track = &graph.tracks[index];
        runtime.track_l[..frames].iter_mut().for_each(|s| *s = 0.0);
        runtime.track_r[..frames].iter_mut().for_each(|s| *s = 0.0);

        if !track.active {
            if track.is_bus {
                if let Some(bus) = runtime.bus_l.get_mut(&index) {
                    bus[..frames].iter_mut().for_each(|s| *s = 0.0);
                }
                if let Some(bus) = runtime.bus_r.get_mut(&index) {
                    bus[..frames].iter_mut().for_each(|s| *s = 0.0);
                }
            }
            graph.meters.store(index, 0.0);
            continue;
        }

        if playing && !track.clips.is_empty() {
            render_clips(track, runtime, start_frame, frames);
        }

        if let Some(_settings) = &track.instrument {
            let track_id = track.id.clone();
            let mut cursor = runtime
                .tracks
                .get(&track_id)
                .map(|r| r.cursor)
                .unwrap_or(0);
            let events = &track.midi_events;
            let mono = &mut runtime.synth_mono[..frames];
            mono.iter_mut().for_each(|s| *s = 0.0);
            let mut rendered = 0usize;
            if let Some(track_runtime) = runtime.tracks.get_mut(&track_id) {
                if let Some(synth) = &mut track_runtime.synth {
                    if playing {
                        while cursor < events.len() {
                            let event = events[cursor];
                            if event.frame < start_frame {
                                cursor += 1;
                                continue;
                            }
                            let offset = (event.frame.saturating_sub(start_frame)) as usize;
                            if offset >= frames {
                                break;
                            }
                            if offset > rendered {
                                synth.render_add(&mut mono[rendered..offset]);
                                rendered = offset;
                            }
                            match event.kind {
                                MidiEventKind::NoteOn { note, velocity } => {
                                    synth.note_on(note, velocity)
                                }
                                MidiEventKind::NoteOff { note } => synth.note_off(note),
                                MidiEventKind::Sustain(down) => synth.set_sustain_pedal(down),
                                MidiEventKind::PitchBend(value) => synth.set_pitch_bend(value),
                            }
                            cursor += 1;
                        }
                    }
                    if rendered < frames {
                        synth.render_add(&mut mono[rendered..]);
                    }
                }
            }
            runtime
                .tracks
                .get_mut(&track_id)
                .map(|r| r.cursor = cursor);
            for i in 0..frames {
                let sample = mono[i];
                runtime.track_l[i] += sample;
                runtime.track_r[i] += sample;
            }
        }

        if track.is_bus {
            if let (Some(bus_l), Some(bus_r)) =
                (runtime.bus_l.get_mut(&index), runtime.bus_r.get_mut(&index))
            {
                for i in 0..frames {
                    runtime.track_l[i] += bus_l[i];
                    runtime.track_r[i] += bus_r[i];
                    bus_l[i] = 0.0;
                    bus_r[i] = 0.0;
                }
            }
        }

        if let Some(track_runtime) = runtime.tracks.get_mut(&track.id) {
            for (effect, insert) in track_runtime.effects.iter_mut().zip(track.inserts.iter()) {
                effect.process(
                    insert,
                    &mut runtime.track_l[..frames],
                    &mut runtime.track_r[..frames],
                    graph.sample_rate,
                );
            }
        }

        let mut peak_l = 0.0f32;
        let mut peak_r = 0.0f32;
        for i in 0..frames {
            let l = runtime.track_l[i] * track.gain * track.pan_l;
            let r = runtime.track_r[i] * track.gain * track.pan_r;
            runtime.track_l[i] = l;
            runtime.track_r[i] = r;
            peak_l = peak_l.max(l.abs());
            peak_r = peak_r.max(r.abs());
        }
        runtime.meter_peaks[index] = peak_l.max(peak_r);
        if let Some(parent) = track.parent {
            if let (Some(bus_l), Some(bus_r)) =
                (runtime.bus_l.get_mut(&parent), runtime.bus_r.get_mut(&parent))
            {
                for i in 0..frames {
                    bus_l[i] += runtime.track_l[i];
                    bus_r[i] += runtime.track_r[i];
                }
            }
        } else {
            for i in 0..frames {
                runtime.master_l[i] += runtime.track_l[i];
                runtime.master_r[i] += runtime.track_r[i];
            }
        }
    }

    for (effect, insert) in runtime.master_effects.iter_mut().zip(graph.master.inserts.iter()) {
        effect.process(
            insert,
            &mut runtime.master_l[..frames],
            &mut runtime.master_r[..frames],
            graph.sample_rate,
        );
    }

    let mut master_peak = 0.0f32;
    for i in 0..frames {
        let mut l = runtime.master_l[i] * graph.master.gain * graph.master.pan_l;
        let mut r = runtime.master_r[i] * graph.master.gain * graph.master.pan_r;
        if graph.master.limiter {
            l = soft_clip(l);
            r = soft_clip(r);
        }
        runtime.master_l[i] = l;
        runtime.master_r[i] = r;
        master_peak = master_peak.max(l.abs()).max(r.abs());
    }

    if playing && graph.metronome {
        render_metronome(graph, start_frame, frames, &mut runtime.master_l, &mut runtime.master_r);
    }

    for (index, peak) in runtime.meter_peaks.iter().enumerate() {
        if index < graph.tracks.len() {
            graph.meters.store(index, *peak);
        }
    }
    graph.meters.store(graph.tracks.len(), master_peak);
    if !playing && runtime.meter_peaks.iter().all(|p| *p == 0.0) {
        graph.meters.store(graph.tracks.len(), 0.0);
    }

    frames
}

fn render_metronome(
    graph: &RenderGraph,
    start_frame: u64,
    frames: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    let ppq = graph.ppq as u64;
    if ppq == 0 {
        return;
    }
    let start_tick = crate::project::time::frames_to_ticks(
        start_frame,
        graph.tempo,
        graph.ppq,
        graph.sample_rate,
    );
    let end_tick = crate::project::time::frames_to_ticks(
        start_frame + frames as u64,
        graph.tempo,
        graph.ppq,
        graph.sample_rate,
    );
    let first_beat = start_tick / ppq;
    let last_beat = (end_tick / ppq) + 1;
    let click_frames = (graph.sample_rate as f32 * 0.028) as usize;
    for beat in first_beat..=last_beat {
        let beat_frame = ticks_to_frames(beat * ppq, graph.tempo, graph.ppq, graph.sample_rate);
        if beat_frame < start_frame || beat_frame >= start_frame + frames as u64 {
            continue;
        }
        let offset = (beat_frame - start_frame) as usize;
        let accent = beat % graph.time_signature_numerator.max(1) as u64 == 0;
        let freq = if accent { 1_560.0 } else { 1_040.0 };
        let amp = if accent { 0.32 } else { 0.22 };
        for i in 0..click_frames.min(frames - offset) {
            let t = i as f32 / graph.sample_rate as f32;
            let env = (-t * 55.0).exp();
            let sample = (t * freq * std::f32::consts::TAU).sin() * env * amp;
            left[offset + i] += sample;
            right[offset + i] += sample;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{AudioClip, MidiNote, MidiPart, Project, Track};

    fn project_with_synth() -> Project {
        let mut project = Project::new("Synth Test");
        project.tempo = 120.0;
        let mut track = Track::new(TrackKind::Instrument, "Synth", "#4f8fce");
        track.parts.push(MidiPart {
            id: "part".into(),
            start_ticks: 0,
            duration_ticks: 3840,
            notes: vec![MidiNote {
                id: "n1".into(),
                pitch: 60,
                start_ticks: 0,
                duration_ticks: 480,
                velocity: 100,
                channel: 0,
            }],
            ..Default::default()
        });
        project.tracks.push(track);
        project
    }

    #[test]
    fn offline_render_contains_signal() {
        let mut project = project_with_synth();
        project.master.limiter = true;
        let mut cache = AssetCache::default();
        let built = build_render_graph(&project, 48_000, &mut cache, 1, None);
        let graph = built.graph;
        let mut runtime = RenderRuntime::new();
        let mut stats = 0.0f32;
        let mut position = 0u64;
        for block in 0..40 {
            render_block(&graph, &mut runtime, position, 480, true, block as u64);
            for i in 0..480 {
                stats = stats.max(runtime.master_l[i].abs());
            }
            position += 480;
        }
        assert!(stats > 0.001, "offline render was silent");
        assert!(stats <= 1.0);
    }

    #[test]
    fn solo_and_mute_affect_audibility() {
        let mut project = project_with_synth();
        let mut second = Track::new(TrackKind::Instrument, "Second", "#a55");
        second.parts.push(MidiPart {
            id: "p2".into(),
            notes: vec![MidiNote {
                id: "n2".into(),
                pitch: 67,
                duration_ticks: 480,
                ..Default::default()
            }],
            ..Default::default()
        });
        project.tracks.push(second);
        project.tracks[0].mute = true;
        let mut cache = AssetCache::default();
        let built = build_render_graph(&project, 48_000, &mut cache, 1, None);
        assert!(!built.graph.tracks[0].active);
        assert!(built.graph.tracks[1].active);
        project.tracks[0].mute = false;
        project.tracks[1].solo = true;
        let built = build_render_graph(&project, 48_000, &mut cache, 2, None);
        assert!(!built.graph.tracks[0].active);
        assert!(built.graph.tracks[1].active);
    }

    #[test]
    fn group_routing_is_ordered_and_valid() {
        let mut project = Project::new("Routing");
        let mut audio = Track::new(TrackKind::Audio, "Audio", "#4f8fce");
        audio.output = "group-id".into();
        let mut group = Track::new(TrackKind::Group, "Group", "#7a7");
        group.id = "group-id".into();
        project.tracks.push(audio);
        project.tracks.push(group);
        let mut cache = AssetCache::default();
        let built = build_render_graph(&project, 48_000, &mut cache, 1, None);
        let order = &built.graph.order;
        let audio_index = order.iter().position(|i| *i == 0).unwrap();
        let group_index = order.iter().position(|i| *i == 1).unwrap();
        assert!(audio_index < group_index);
        assert_eq!(built.graph.tracks[0].parent, Some(1));

        // A self-route must not create a feedback loop.
        let mut cyclic = Project::new("Cycle");
        let mut group = Track::new(TrackKind::Group, "G", "#777");
        group.id = "g".into();
        group.output = "g".into();
        cyclic.tracks.push(group);
        let built = build_render_graph(&cyclic, 48_000, &mut cache, 2, None);
        assert_eq!(built.graph.tracks[0].parent, None);
    }

    #[test]
    fn split_clip_offset_starts_at_the_split_frame() {
        let dir = std::env::temp_dir().join(format!("studio-split-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("ramp.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
        for i in 0..48_000 {
            let value = ((i as f32 / 48_000.0) * i16::MAX as f32) as i16;
            writer.write_sample(value).unwrap();
            writer.write_sample(value).unwrap();
        }
        writer.finalize().unwrap();

        let mut project = Project::new("Split");
        project.tempo = 120.0;
        project.ppq = 960;
        let mut track = Track::new(TrackKind::Audio, "Audio", "#4f8fce");
        // A split at tick 480 leaves the right half starting at source frame
        // 12_000 (0.25 s at 120 BPM). If offset_ticks is ignored, the right
        // clip replays frame 0 instead.
        track.clips.push(AudioClip {
            id: "left".into(),
            media_path: wav.to_string_lossy().to_string(),
            start_ticks: 0,
            duration_ticks: 480,
            offset_ticks: 0,
            ..Default::default()
        });
        track.clips.push(AudioClip {
            id: "right".into(),
            media_path: wav.to_string_lossy().to_string(),
            start_ticks: 480,
            duration_ticks: 480,
            offset_ticks: 480,
            ..Default::default()
        });
        project.tracks.push(track);

        let mut cache = AssetCache::default();
        let built = build_render_graph(&project, 48_000, &mut cache, 1, None);
        assert!(built.missing_media.is_empty());
        let graph = built.graph;
        let right = graph.tracks[0]
            .clips
            .iter()
            .find(|clip| clip.id == "right")
            .unwrap();
        assert_eq!(right.start_frame, 12_000);
        assert!((right.source_start_frame - 12_000.0).abs() < 1.0);

        let mut runtime = RenderRuntime::new();
        render_block(&graph, &mut runtime, 12_000, 480, true, 1);
        assert!(
            runtime.master_l[0] > 0.1,
            "right half started at the beginning of the media (sample {})",
            runtime.master_l[0]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn audio_clip_plays_at_expected_time() {
        let dir = std::env::temp_dir().join(format!("studio-render-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
        for i in 0..4_800 {
            let s = ((i as f32 / 48_000.0) * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            let v = (s * i16::MAX as f32) as i16;
            writer.write_sample(v).unwrap();
            writer.write_sample(v).unwrap();
        }
        writer.finalize().unwrap();

        let mut project = Project::new("Audio");
        let mut track = Track::new(TrackKind::Audio, "Audio", "#4f8fce");
        track.clips.push(AudioClip {
            id: "clip".into(),
            media_path: wav.to_string_lossy().to_string(),
            start_ticks: 960,
            duration_ticks: 960,
            ..Default::default()
        });
        project.tracks.push(track);
        let mut cache = AssetCache::default();
        let built = build_render_graph(&project, 48_000, &mut cache, 1, None);
        assert!(built.missing_media.is_empty());
        assert_eq!(built.graph.tracks[0].clips[0].start_frame, 24_000);
        let graph = built.graph;
        let mut runtime = RenderRuntime::new();
        render_block(&graph, &mut runtime, 0, 480, true, 1);
        assert!(runtime.master_l[..480].iter().all(|s| *s == 0.0));
        render_block(&graph, &mut runtime, 24_000, 480, true, 1);
        assert!(runtime.master_l[..480].iter().any(|s| s.abs() > 0.001));
        let _ = std::fs::remove_dir_all(dir);
    }
}
