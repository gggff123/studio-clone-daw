use crate::audio::asset::AssetCache;
use crate::audio::render::{build_render_graph, render_block, RenderRuntime};
use crate::project::time::{frames_to_ticks, ticks_to_frames};
use crate::project::Project;
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u8,
    pub start_ticks: u64,
    pub end_ticks: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub sample_rate: u32,
    pub bit_depth: u16,
    pub channels: u8,
    pub frames: u64,
    pub duration_seconds: f64,
    pub peak: f32,
}

fn temp_output(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "export.wav".into());
    path.with_file_name(format!(".{name}.{}.tmp.wav", uuid::Uuid::new_v4()))
}

/// Render a project through the same graph used for live playback and write a
/// standards-compliant WAV file. `progress` receives values in 0.0..=1.0.
pub fn export_project_wav<F>(
    project: &Project,
    path: &Path,
    options: &ExportOptions,
    cache: &mut AssetCache,
    mut progress: F,
) -> Result<ExportResult, String>
where
    F: FnMut(f32),
{
    if path.as_os_str().is_empty() {
        return Err("No export destination was selected.".into());
    }
    if options.channels != 1 && options.channels != 2 {
        return Err("Export supports mono or stereo only.".into());
    }
    let sample_rate = options.sample_rate.clamp(8_000, 192_000);
    let start_ticks = options.start_ticks;
    let end_ticks = if options.end_ticks > start_ticks {
        options.end_ticks
    } else {
        project.end_ticks().max(start_ticks + project.ppq as u64)
    };
    let mut render_project = project.clone();
    render_project.metronome = false;
    render_project.loop_region.enabled = false;
    let built = build_render_graph(
        &render_project,
        sample_rate,
        cache,
        0xE000_0000,
        None,
    );
    let graph = built.graph;
    let start_frame = ticks_to_frames(start_ticks, graph.tempo, graph.ppq, sample_rate);
    let end_frame = ticks_to_frames(end_ticks, graph.tempo, graph.ppq, sample_rate)
        .max(start_frame + 1);
    let total_frames = end_frame.saturating_sub(start_frame);
    if total_frames == 0 {
        return Err("The export range is empty.".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create export folder: {e}"))?;
    }

    let spec = WavSpec {
        channels: options.channels as u16,
        sample_rate,
        bits_per_sample: options.bit_depth,
        sample_format: if options.bit_depth == 32 {
            SampleFormat::Float
        } else {
            SampleFormat::Int
        },
    };
    if !matches!(options.bit_depth, 16 | 24 | 32) {
        return Err("Bit depth must be 16, 24 or 32-bit float.".into());
    }

    let temp = temp_output(path);
    let mut writer = WavWriter::create(&temp, spec)
        .map_err(|e| format!("Cannot create WAV file: {e}"))?;
    let mut runtime = RenderRuntime::new();
    let mut position = start_frame;
    let mut peak = 0.0f32;
    let block_size = 4096usize;
    let mut last_progress = -1i32;

    while position < end_frame {
        let count = (end_frame - position).min(block_size as u64) as usize;
        render_block(&graph, &mut runtime, position, count, true, 1);
        for i in 0..count {
            let l = runtime.master_l[i].clamp(-1.0, 1.0);
            let r = runtime.master_r[i].clamp(-1.0, 1.0);
            peak = peak.max(l.abs()).max(r.abs());
            match options.bit_depth {
                16 => {
                    if options.channels == 1 {
                        let value = (l + r) * 0.5;
                        writer
                            .write_sample((value * i16::MAX as f32) as i16)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    } else {
                        writer
                            .write_sample((l * i16::MAX as f32) as i16)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                        writer
                            .write_sample((r * i16::MAX as f32) as i16)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    }
                }
                24 => {
                    let scale = 8_388_607.0f32;
                    if options.channels == 1 {
                        let value = (l + r) * 0.5;
                        writer
                            .write_sample((value * scale) as i32)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    } else {
                        writer
                            .write_sample((l * scale) as i32)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                        writer
                            .write_sample((r * scale) as i32)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    }
                }
                _ => {
                    if options.channels == 1 {
                        writer
                            .write_sample((l + r) * 0.5)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    } else {
                        writer
                            .write_sample(l)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                        writer
                            .write_sample(r)
                            .map_err(|e| format!("WAV write failed: {e}"))?;
                    }
                }
            }
        }
        position += count as u64;
        let fraction = (position - start_frame) as f64 / total_frames as f64;
        let bucket = (fraction * 100.0) as i32;
        if bucket != last_progress {
            last_progress = bucket;
            progress(fraction as f32);
        }
    }

    writer
        .finalize()
        .map_err(|e| format!("Cannot finalize WAV file: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot move exported file into place: {e}")
    })?;
    progress(1.0);

    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        sample_rate,
        bit_depth: options.bit_depth,
        channels: options.channels,
        frames: total_frames,
        duration_seconds: total_frames as f64 / sample_rate as f64,
        peak,
    })
}

#[allow(dead_code)]
fn _range_ticks(start: u64, end: u64, project: &Project) -> (u64, u64) {
    (
        frames_to_ticks(
            ticks_to_frames(start, project.tempo, project.ppq, project.sample_rate),
            project.tempo,
            project.ppq,
            project.sample_rate,
        ),
        end,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{MidiNote, MidiPart, Track, TrackKind};

    fn synth_project() -> Project {
        let mut project = Project::new("Export");
        project.tempo = 120.0;
        let mut track = Track::new(TrackKind::Instrument, "Synth", "#4f8fce");
        track.parts.push(MidiPart {
            id: "part".into(),
            notes: vec![MidiNote {
                id: "n".into(),
                pitch: 69,
                start_ticks: 0,
                duration_ticks: 960,
                velocity: 120,
                channel: 0,
            }],
            duration_ticks: 1920,
            ..Default::default()
        });
        project.tracks.push(track);
        project
    }

    #[test]
    fn exports_valid_nonzero_wav() {
        let dir = std::env::temp_dir().join(format!("studio-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mix.wav");
        let project = synth_project();
        let options = ExportOptions {
            sample_rate: 44_100,
            bit_depth: 16,
            channels: 2,
            start_ticks: 0,
            end_ticks: 960,
        };
        let mut cache = AssetCache::default();
        let mut last = 0.0;
        let result = export_project_wav(&project, &path, &options, &mut cache, |p| last = p)
            .unwrap();
        assert!(path.exists());
        assert_eq!(result.sample_rate, 44_100);
        assert_eq!(result.channels, 2);
        assert_eq!(result.frames, 22_050);
        assert!(result.peak > 0.001, "export peak was {}", result.peak);
        assert_eq!(last, 1.0);
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 2);
        assert_eq!(spec.sample_rate, 44_100);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(reader.duration() as u64, 22_050);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exports_mono_24_bit_with_range() {
        let dir = std::env::temp_dir().join(format!("studio-export24-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mono.wav");
        let project = synth_project();
        let options = ExportOptions {
            sample_rate: 48_000,
            bit_depth: 24,
            channels: 1,
            start_ticks: 0,
            end_ticks: 480,
        };
        let mut cache = AssetCache::default();
        let result = export_project_wav(&project, &path, &options, &mut cache, |_| {}).unwrap();
        assert_eq!(result.channels, 1);
        assert_eq!(result.frames, 12_000);
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().bits_per_sample, 24);
        assert_eq!(reader.duration() as u64, 12_000);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_options_fail() {
        let path = std::env::temp_dir().join("nope.wav");
        let project = synth_project();
        let mut cache = AssetCache::default();
        let mut options = ExportOptions {
            sample_rate: 48_000,
            bit_depth: 8,
            channels: 2,
            start_ticks: 0,
            end_ticks: 960,
        };
        assert!(export_project_wav(&project, &path, &options, &mut cache, |_| {}).is_err());
        options.bit_depth = 16;
        options.channels = 3;
        assert!(export_project_wav(&project, &path, &options, &mut cache, |_| {}).is_err());
    }
}
