use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const WAVEFORM_BUCKETS: usize = 2048;

#[derive(Debug)]
pub struct AudioAsset {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
    pub duration_seconds: f64,
    pub peaks: Vec<f32>,
}

impl AudioAsset {
    pub fn frame_count(&self) -> u64 {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() as u64 / self.channels as u64
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportResult {
    pub path: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_seconds: f64,
    pub frames: u64,
    pub peaks: Vec<f32>,
}

#[derive(Default)]
pub struct AssetCache {
    entries: HashMap<String, Arc<AudioAsset>>,
}

fn cache_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

impl AssetCache {
    pub fn get(&self, path: &Path) -> Option<Arc<AudioAsset>> {
        self.entries.get(&cache_key(path)).cloned()
    }

    pub fn insert(&mut self, asset: Arc<AudioAsset>) -> Arc<AudioAsset> {
        self.entries
            .insert(cache_key(&asset.path), asset.clone());
        asset
    }

    pub fn load(&mut self, path: &Path) -> Result<Arc<AudioAsset>, String> {
        if let Some(asset) = self.get(path) {
            return Ok(asset);
        }
        let asset = Arc::new(decode_audio_file(path)?);
        Ok(self.insert(asset))
    }

    pub fn invalidate(&mut self, path: &Path) {
        self.entries.remove(&cache_key(path));
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn compute_peaks(samples: &[f32], channels: u16, buckets: usize) -> Vec<f32> {
    if samples.is_empty() || channels == 0 || buckets == 0 {
        return vec![0.0; buckets];
    }
    let frames = samples.len() / channels as usize;
    let mut peaks = vec![0.0f32; buckets];
    for (frame_index, frame) in samples.chunks_exact(channels as usize).enumerate() {
        let bucket = frame_index * buckets / frames.max(1);
        let mut peak = 0.0f32;
        for sample in frame {
            peak = peak.max(sample.abs());
        }
        if bucket < buckets {
            peaks[bucket] = peaks[bucket].max(peak);
        }
    }
    peaks
}

/// Decode an audio file to stereo f32 interleaved samples using Symphonia.
/// Source sample rate and channel count are retained for correct playback
/// resampling and waveform display.
pub fn decode_audio_file(path: &Path) -> Result<AudioAsset, String> {
    if !path.exists() {
        return Err(format!("Audio file not found: {}", path.display()));
    }
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Unsupported or damaged audio file: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "The file contains no decodable audio track.".to_string())?;
    let track_id = track.id;
    let source_channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2) as u16;
    let source_rate = track.codec_params.sample_rate.unwrap_or(48_000);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("No decoder for this audio format: {e}"))?;

    let mut interleaved: Vec<f32> = Vec::new();
    let mut decoded_rate = source_rate;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(err) => return Err(format!("Error reading audio data: {err}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                decoded_rate = decoded.spec().rate;
                let spec = *decoded.spec();
                let duration = decoded.capacity() as u64;
                let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
                sample_buf.copy_interleaved_ref(decoded);
                interleaved.extend_from_slice(sample_buf.samples());
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(err) => return Err(format!("Audio decoding failed: {err}")),
        }
    }

    if interleaved.is_empty() {
        return Err("The audio file decoded to zero samples.".into());
    }

    // Normalize to stereo interleaved.
    let mut stereo = Vec::with_capacity(interleaved.len() * 2);
    let effective_channels = source_channels.max(1) as usize;
    for frame in interleaved.chunks(effective_channels) {
        match frame.len() {
            0 => {}
            1 => {
                stereo.push(frame[0]);
                stereo.push(frame[0]);
            }
            _ => {
                stereo.push(frame[0]);
                stereo.push(frame[1]);
            }
        }
    }

    let frames = stereo.len() as u64 / 2;
    let duration_seconds = frames as f64 / decoded_rate as f64;
    let peaks = compute_peaks(&stereo, 2, WAVEFORM_BUCKETS);

    Ok(AudioAsset {
        path: path.to_path_buf(),
        sample_rate: decoded_rate,
        channels: 2,
        samples: stereo,
        duration_seconds,
        peaks,
    })
}

pub fn import_result(asset: &AudioAsset) -> AudioImportResult {
    let name = asset
        .path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Audio".into());
    AudioImportResult {
        path: asset.path.to_string_lossy().to_string(),
        name,
        sample_rate: asset.sample_rate,
        channels: asset.channels,
        duration_seconds: asset.duration_seconds,
        frames: asset.frame_count(),
        peaks: asset.peaks.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};

    fn write_test_wav(path: &Path, seconds: f32, rate: u32) {
        let spec = WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        let frames = (rate as f32 * seconds) as u32;
        for i in 0..frames {
            let value = (i as f32 / rate as f32 * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            let sample = (value * i16::MAX as f32) as i16;
            writer.write_sample(sample).unwrap();
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn decodes_wav_to_stereo_with_peaks() {
        let dir = std::env::temp_dir().join(format!("studio-asset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        write_test_wav(&path, 0.5, 44_100);
        let asset = decode_audio_file(&path).unwrap();
        assert_eq!(asset.channels, 2);
        assert_eq!(asset.sample_rate, 44_100);
        assert!((asset.duration_seconds - 0.5).abs() < 0.01);
        assert!(asset.peaks.iter().any(|p| *p > 0.1));
        assert_eq!(asset.peaks.len(), WAVEFORM_BUCKETS);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cache_reuses_decoded_asset() {
        let dir = std::env::temp_dir().join(format!("studio-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        write_test_wav(&path, 0.1, 48_000);
        let mut cache = AssetCache::default();
        let a = cache.load(&path).unwrap();
        let b = cache.load(&path).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(cache.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_and_invalid_files_fail_cleanly() {
        let dir = std::env::temp_dir().join(format!("studio-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.wav");
        assert!(decode_audio_file(&missing).is_err());
        let bad = dir.join("bad.wav");
        std::fs::write(&bad, b"this is not audio").unwrap();
        assert!(decode_audio_file(&bad).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
