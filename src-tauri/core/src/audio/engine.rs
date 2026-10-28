use crate::audio::render::{build_render_graph, render_block, RenderGraph, RenderRuntime};
use crate::project::time::{frames_to_ticks, ticks_to_frames};
use crate::project::Project;
use arc_swap::ArcSwapOption;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use crossbeam_channel::{bounded, Receiver, Sender};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Read the human-readable name of a CPAL device.
fn device_display_name(device: &cpal::Device) -> Option<String> {
    device
        .description()
        .ok()
        .map(|description| description.name().to_string())
}

#[derive(Clone, Debug)]
pub enum LiveEventKind {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    Sustain(bool),
    PitchBend(f32),
}

#[derive(Clone, Debug)]
pub struct LiveEvent {
    pub track_id: String,
    pub kind: LiveEventKind,
}

pub struct EngineShared {
    pub graph: ArcSwapOption<RenderGraph>,
    pub playing: AtomicBool,
    pub recording: AtomicBool,
    pub position: AtomicU64,
    pub loop_enabled: AtomicBool,
    pub loop_start: AtomicU64,
    pub loop_end: AtomicU64,
    pub reset_seq: AtomicU64,
    pub sample_rate: AtomicU32,
    pub device_failed: AtomicBool,
    pub device_error: Mutex<Option<String>>,
    pub live_tx: Sender<LiveEvent>,
    pub live_rx: Receiver<LiveEvent>,
}

impl EngineShared {
    fn new() -> Self {
        let (live_tx, live_rx) = bounded(2048);
        Self {
            graph: ArcSwapOption::empty(),
            playing: AtomicBool::new(false),
            recording: AtomicBool::new(false),
            position: AtomicU64::new(0),
            loop_enabled: AtomicBool::new(false),
            loop_start: AtomicU64::new(0),
            loop_end: AtomicU64::new(0),
            reset_seq: AtomicU64::new(1),
            sample_rate: AtomicU32::new(48_000),
            device_failed: AtomicBool::new(false),
            device_error: Mutex::new(None),
            live_tx,
            live_rx,
        }
    }

    fn bump_reset(&self) {
        self.reset_seq.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub default_sample_rate: u32,
    pub supported_sample_rates: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceList {
    pub outputs: Vec<AudioDeviceInfo>,
    pub inputs: Vec<String>,
    pub current_output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSelection {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterValue {
    pub track_id: String,
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportState {
    pub playing: bool,
    pub recording: bool,
    pub position_frames: u64,
    pub position_ticks: u64,
    pub position_seconds: f64,
    pub end_ticks: u64,
    pub sample_rate: u32,
    pub tempo: f64,
    pub ppq: u32,
    pub loop_enabled: bool,
    pub loop_start_ticks: u64,
    pub loop_end_ticks: u64,
    pub metronome: bool,
    pub master_peak: f32,
    pub meters: Vec<MeterValue>,
    pub output_device: Option<String>,
    pub engine_ready: bool,
    pub device_error: Option<String>,
}

pub struct AudioEngine {
    shared: Arc<EngineShared>,
    stream: Option<cpal::Stream>,
    output_device: Option<String>,
    sample_rate: u32,
    channels: u16,
    sample_format: String,
    error: Option<String>,
}

pub struct EngineLoadSummary {
    pub missing_media: Vec<String>,
    pub track_count: usize,
}

impl AudioEngine {
    pub fn new() -> Self {
        let shared = Arc::new(EngineShared::new());
        let mut engine = Self {
            shared,
            stream: None,
            output_device: None,
            sample_rate: 48_000,
            channels: 2,
            sample_format: "unknown".into(),
            error: None,
        };
        match engine.create_stream(None, None) {
            Ok(selection) => {
                engine.output_device = Some(selection.name);
                engine.sample_rate = selection.sample_rate;
                engine.channels = selection.channels;
                engine.sample_format = selection.sample_format;
            }
            Err(err) => {
                engine.error = Some(err);
            }
        }
        engine
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn load_project(&mut self, project: &Project, cache: &mut crate::audio::asset::AssetCache) -> EngineLoadSummary {
        let sample_rate = if self.sample_rate == 0 { 48_000 } else { self.sample_rate };
        let existing = self
            .shared
            .graph
            .load()
            .as_ref()
            .map(|g| g.meters.clone());
        let generation = self
            .shared
            .graph
            .load()
            .as_ref()
            .map(|g| g.generation.wrapping_add(1))
            .unwrap_or(1);
        let built = build_render_graph(project, sample_rate, cache, generation, existing);
        self.shared.loop_enabled.store(project.loop_region.enabled, Ordering::SeqCst);
        self.shared
            .loop_start
            .store(built.graph.loop_start_frame, Ordering::SeqCst);
        self.shared
            .loop_end
            .store(built.graph.loop_end_frame, Ordering::SeqCst);
        let track_count = built.graph.tracks.len();
        let missing_media = built.missing_media;
        self.shared.graph.store(Some(Arc::new(built.graph)));
        self.shared.bump_reset();
        EngineLoadSummary {
            missing_media,
            track_count,
        }
    }

    pub fn play(&self) {
        if self.stream.is_none() {
            return;
        }
        self.shared.playing.store(true, Ordering::SeqCst);
        self.shared.bump_reset();
    }

    pub fn set_recording(&self, recording: bool) {
        self.shared.recording.store(recording, Ordering::SeqCst);
    }

    pub fn pause(&self) {
        self.shared.playing.store(false, Ordering::SeqCst);
        self.shared.bump_reset();
    }

    pub fn stop(&self) {
        self.shared.playing.store(false, Ordering::SeqCst);
        self.shared.bump_reset();
    }

    pub fn seek_ticks(&self, ticks: u64) {
        let frames = {
            let guard = self.shared.graph.load();
            match guard.as_ref() {
                Some(graph) => ticks_to_frames(
                    ticks,
                    graph.tempo,
                    graph.ppq,
                    graph.sample_rate,
                ),
                None => ticks_to_frames(ticks, 120.0, 960, self.sample_rate),
            }
        };
        self.shared.position.store(frames, Ordering::SeqCst);
        self.shared.bump_reset();
        if let Some(graph) = self.shared.graph.load().as_ref() {
            graph.meters.reset();
        }
    }

    pub fn return_to_start(&self) {
        self.shared.position.store(0, Ordering::SeqCst);
        self.shared.bump_reset();
    }

    pub fn set_loop(&self, enabled: bool, start_ticks: u64, end_ticks: u64) {
        let (start, end) = {
            let guard = self.shared.graph.load();
            match guard.as_ref() {
                Some(graph) => (
                    ticks_to_frames(start_ticks, graph.tempo, graph.ppq, graph.sample_rate),
                    ticks_to_frames(
                        end_ticks.max(start_ticks + 1),
                        graph.tempo,
                        graph.ppq,
                        graph.sample_rate,
                    ),
                ),
                None => (0, 0),
            }
        };
        self.shared.loop_enabled.store(enabled, Ordering::SeqCst);
        self.shared.loop_start.store(start, Ordering::SeqCst);
        self.shared.loop_end.store(end, Ordering::SeqCst);
    }

    pub fn live_sender(&self) -> Sender<LiveEvent> {
        self.shared.live_tx.clone()
    }

    pub fn audition_note(&self, track_id: &str, note: u8, velocity: u8, on: bool) {        let kind = if on {
            LiveEventKind::NoteOn { note, velocity }
        } else {
            LiveEventKind::NoteOff { note }
        };
        let _ = self.shared.live_tx.try_send(LiveEvent {
            track_id: track_id.to_string(),
            kind,
        });
    }

    pub fn audition_sustain(&self, track_id: &str, down: bool) {
        let _ = self.shared.live_tx.try_send(LiveEvent {
            track_id: track_id.to_string(),
            kind: LiveEventKind::Sustain(down),
        });
    }

    pub fn audition_pitch_bend(&self, track_id: &str, value: f32) {
        let _ = self.shared.live_tx.try_send(LiveEvent {
            track_id: track_id.to_string(),
            kind: LiveEventKind::PitchBend(value),
        });
    }

    pub fn set_output_device(
        &mut self,
        name: Option<String>,
        sample_rate: Option<u32>,
    ) -> Result<DeviceSelection, String> {
        let selection = self.create_stream(name.clone(), sample_rate)?;
        self.output_device = Some(selection.name.clone());
        self.sample_rate = selection.sample_rate;
        self.channels = selection.channels;
        self.sample_format = selection.sample_format.clone();
        self.error = None;
        Ok(selection)
    }

    pub fn state(&self) -> TransportState {
        let guard = self.shared.graph.load();
        let graph = guard.as_ref();
        let position_frames = self.shared.position.load(Ordering::Relaxed);
        let sample_rate = graph
            .map(|g| g.sample_rate)
            .unwrap_or(self.sample_rate)
            .max(1);
        let tempo = graph.map(|g| g.tempo).unwrap_or(120.0);
        let ppq = graph.map(|g| g.ppq).unwrap_or(960);
        let position_ticks = frames_to_ticks(position_frames, tempo, ppq, sample_rate);
        let loop_start = self.shared.loop_start.load(Ordering::Relaxed);
        let loop_end = self.shared.loop_end.load(Ordering::Relaxed);
        let (meters, master_peak, end_ticks, metronome) = match graph {
            Some(graph) => {
                let values = graph
                    .meters
                    .ids
                    .iter()
                    .map(|id| MeterValue {
                        track_id: id.clone(),
                        peak: 0.0,
                    })
                    .collect::<Vec<_>>();
                let peaks = graph.meters.read();
                let mut meters = values;
                for (index, meter) in meters.iter_mut().enumerate() {
                    if index < graph.tracks.len() {
                        meter.peak = peaks.get(index).copied().unwrap_or(0.0);
                    } else {
                        meter.peak = peaks.get(index).copied().unwrap_or(0.0);
                    }
                }
                let master_peak = peaks
                    .get(graph.tracks.len())
                    .copied()
                    .unwrap_or(0.0);
                let end_ticks = frames_to_ticks(graph.end_frame, tempo, ppq, sample_rate);
                (meters, master_peak, end_ticks, graph.metronome)
            }
            None => (Vec::new(), 0.0, 0, false),
        };
        let device_error = self
            .shared
            .device_error
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .or_else(|| self.error.clone());
        TransportState {
            playing: self.shared.playing.load(Ordering::Relaxed),
            recording: self.shared.recording.load(Ordering::Relaxed),
            position_frames,
            position_ticks,
            position_seconds: position_frames as f64 / sample_rate as f64,
            end_ticks,
            sample_rate,
            tempo,
            ppq,
            loop_enabled: self.shared.loop_enabled.load(Ordering::Relaxed),
            loop_start_ticks: frames_to_ticks(loop_start, tempo, ppq, sample_rate),
            loop_end_ticks: frames_to_ticks(loop_end, tempo, ppq, sample_rate),
            metronome,
            master_peak,
            meters,
            output_device: self.output_device.clone(),
            engine_ready: self.stream.is_some()
                && !self.shared.device_failed.load(Ordering::Relaxed),
            device_error,
        }
    }

    pub fn list_devices(&self) -> AudioDeviceList {
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|d| device_display_name(&d));
        let mut outputs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                let Some(name) = device_display_name(&device) else {
                    continue;
                };
                if !seen.insert(name.clone()) {
                    continue;
                }
                let default_config = device.default_output_config().ok();
                let mut rates = Vec::new();
                if let Ok(configs) = device.supported_output_configs() {
                    for cfg in configs {
                        if cfg.channels() < 2 {
                            continue;
                        }
                        let min = cfg.min_sample_rate();
                        let max = cfg.max_sample_rate();
                        for rate in [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] {
                            if rate >= min && rate <= max && !rates.contains(&rate) {
                                rates.push(rate);
                            }
                        }
                    }
                }
                rates.sort_unstable();
                outputs.push(AudioDeviceInfo {
                    is_default: default_name.as_deref() == Some(name.as_str()),
                    name,
                    channels: default_config.as_ref().map(|c| c.channels()).unwrap_or(2),
                    default_sample_rate: default_config
                        .as_ref()
                        .map(|c| c.sample_rate())
                        .unwrap_or(48_000),
                    supported_sample_rates: rates,
                });
            }
        }
        let mut inputs = Vec::new();
        if let Ok(devices) = host.input_devices() {
            for device in devices {
                if let Some(name) = device_display_name(&device) {
                    if !inputs.contains(&name) {
                        inputs.push(name);
                    }
                }
            }
        }
        AudioDeviceList {
            outputs,
            inputs,
            current_output: self.output_device.clone(),
            error: self.error.clone(),
        }
    }

    fn create_stream(
        &mut self,
        name: Option<String>,
        requested_rate: Option<u32>,
    ) -> Result<DeviceSelection, String> {
        let host = cpal::default_host();
        let device = match name.as_deref() {
            Some(name) if !name.is_empty() => host
                .output_devices()
                .ok()
                .and_then(|mut devices| {
                    devices.find(|d| device_display_name(d).as_deref() == Some(name))
                })
                .ok_or_else(|| format!("Output device '{name}' is no longer available."))?,
            _ => host
                .default_output_device()
                .ok_or_else(|| "No default audio output device is available.".to_string())?,
        };
        let device_name = device_display_name(&device)
            .unwrap_or_else(|| "Default Audio Device".into());
        let default_config = device
            .default_output_config()
            .map_err(|e| format!("Cannot query default output format: {e}"))?;

        let chosen = if let Some(rate) = requested_rate {
            let mut selected = None;
            if let Ok(configs) = device.supported_output_configs() {
                for cfg in configs {
                    if cfg.channels() >= 2
                        && rate >= cfg.min_sample_rate()
                        && rate <= cfg.max_sample_rate()
                    {
                        selected = Some(cfg.with_sample_rate(rate));
                        break;
                    }
                }
            }
            match selected {
                Some(cfg) => cfg,
                None => {
                    return Err(format!(
                        "Device '{device_name}' does not support {rate} Hz with at least 2 channels."
                    ))
                }
            }
        } else {
            default_config
        };

        let sample_format = chosen.sample_format();
        let format_name = format!("{sample_format:?}");
        let mut config: StreamConfig = chosen.config();
        config.buffer_size = BufferSize::Default;
        let channels = config.channels;
        let sample_rate = config.sample_rate;
        self.shared.sample_rate.store(sample_rate, Ordering::SeqCst);
        self.shared.device_failed.store(false, Ordering::SeqCst);
        if let Ok(mut error) = self.shared.device_error.lock() {
            *error = None;
        }
        let shared = self.shared.clone();
        let stream = match sample_format {
            SampleFormat::F32 => build_output_stream::<f32>(&device, config, shared)?,
            SampleFormat::F64 => build_output_stream::<f64>(&device, config, shared)?,
            SampleFormat::I16 => build_output_stream::<i16>(&device, config, shared)?,
            SampleFormat::I32 => build_output_stream::<i32>(&device, config, shared)?,
            SampleFormat::U16 => build_output_stream::<u16>(&device, config, shared)?,
            SampleFormat::U8 => build_output_stream::<u8>(&device, config, shared)?,
            SampleFormat::I8 => build_output_stream::<i8>(&device, config, shared)?,
            SampleFormat::I64 => build_output_stream::<i64>(&device, config, shared)?,
            SampleFormat::U32 => build_output_stream::<u32>(&device, config, shared)?,
            other => {
                return Err(format!(
                    "Unsupported output sample format {other:?}. Choose another device or Windows audio mode."
                ))
            }
        };
        stream
            .play()
            .map_err(|e| format!("Cannot start audio output: {e}"))?;
        self.stream = Some(stream);
        Ok(DeviceSelection {
            name: device_name,
            sample_rate,
            channels,
            sample_format: format_name,
        })
    }
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    shared: Arc<EngineShared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32> + Sample + 'static,
{
    let channels = config.channels as usize;
    let mut runtime = RenderRuntime::new();
    let error_shared = shared.clone();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
                if data.is_empty() {
                    return;
                }
                let total_frames = data.len() / channels.max(1);
                let frames = total_frames.min(8192);
                let guard = shared.graph.load();
                let Some(graph) = guard.as_ref() else {
                    for sample in data.iter_mut() {
                        *sample = T::EQUILIBRIUM;
                    }
                    return;
                };
                let reset_seq = shared.reset_seq.load(Ordering::Relaxed);
                let position = shared.position.load(Ordering::Relaxed);
                runtime.prepare(graph, position, reset_seq);
                while let Ok(event) = shared.live_rx.try_recv() {
                    match event.kind {
                        LiveEventKind::NoteOn { note, velocity } => {
                            runtime.note_on(graph, &event.track_id, note, velocity)
                        }
                        LiveEventKind::NoteOff { note } => {
                            runtime.note_off(&event.track_id, note)
                        }
                        LiveEventKind::Sustain(down) => {
                            runtime.sustain(&event.track_id, down)
                        }
                        LiveEventKind::PitchBend(value) => {
                            runtime.pitch_bend(&event.track_id, value)
                        }
                    }
                }

                let playing = shared.playing.load(Ordering::Relaxed);
                if playing {
                    let mut done = 0usize;
                    let mut safety = 0;
                    while done < frames && safety < 64 {
                        safety += 1;
                        let mut pos = shared.position.load(Ordering::Relaxed);
                        let loop_enabled = shared.loop_enabled.load(Ordering::Relaxed);
                        let loop_start = shared.loop_start.load(Ordering::Relaxed);
                        let loop_end = shared.loop_end.load(Ordering::Relaxed);
                        if loop_enabled && loop_end > loop_start && pos >= loop_end {
                            pos = loop_start;
                            shared.position.store(pos, Ordering::Relaxed);
                            shared.bump_reset();
                            let seq = shared.reset_seq.load(Ordering::Relaxed);
                            runtime.prepare(graph, pos, seq);
                        }
                        let until_end = if loop_enabled && loop_end > loop_start {
                            loop_end.saturating_sub(pos).max(1) as usize
                        } else {
                            usize::MAX
                        };
                        let count = (frames - done).min(until_end).min(8192);
                        let seq = shared.reset_seq.load(Ordering::Relaxed);
                        render_block(graph, &mut runtime, pos, count, true, seq);
                        pos += count as u64;
                        shared.position.store(pos, Ordering::Relaxed);
                        if loop_enabled && loop_end > loop_start && pos >= loop_end {
                            shared.position.store(loop_start, Ordering::Relaxed);
                            shared.bump_reset();
                        }
                        done += count;
                    }
                } else {
                    let seq = shared.reset_seq.load(Ordering::Relaxed);
                    let remaining = frames;
                    render_block(graph, &mut runtime, position, remaining, false, seq);
                }

                for (frame, chunk) in data.chunks_mut(channels).enumerate() {
                    if frame >= frames {
                        for sample in chunk.iter_mut() {
                            *sample = T::EQUILIBRIUM;
                        }
                        continue;
                    }
                    let left = runtime.master_l[frame];
                    let right = runtime.master_r[frame];
                    if channels == 1 {
                        chunk[0] = T::from_sample((left + right) * 0.5);
                    } else {
                        chunk[0] = T::from_sample(left);
                        if channels > 1 {
                            chunk[1] = T::from_sample(right);
                        }
                        for sample in chunk.iter_mut().skip(2) {
                            *sample = T::EQUILIBRIUM;
                        }
                    }
                }
            },
            move |err| {
                if let Ok(mut message) = error_shared.device_error.lock() {
                    *message = Some(format!("Audio output stream error: {err}"));
                }
                error_shared.device_failed.store(true, Ordering::SeqCst);
            },
            None,
        )
        .map_err(|e| format!("Cannot open audio output stream: {e}"))
}
