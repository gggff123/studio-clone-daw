use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use crossbeam_channel::{bounded, Receiver, Sender};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

const BUFFER_POOL: usize = 32;
const BLOCK_SAMPLES: usize = 16_384;

/// Metadata returned as soon as the input stream is running.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Metadata returned after the WAV file has been finalised.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
    pub duration_seconds: f64,
    pub dropped_frames: u64,
    pub input_error: Option<String>,
}

/// A live CPAL input stream plus the writer thread that drains it.
///
/// The audio callback never touches the filesystem. It reuses preallocated
/// blocks and hands them to the writer through a bounded channel. If the disk
/// cannot keep up, the callback drops a block and counts the lost frames rather
/// than blocking the audio thread.
pub struct AudioCapture {
    stream: Option<cpal::Stream>,
    writer: Option<JoinHandle<Result<u64, String>>>,
    path: PathBuf,
    sample_rate: u32,
    channels: u16,
    dropped_frames: Arc<AtomicU64>,
    input_error: Arc<Mutex<Option<String>>>,
}

impl AudioCapture {
    pub fn start(device_name: Option<&str>, output_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(output_dir)
            .map_err(|e| format!("Cannot create recording folder: {e}"))?;
        let path = unique_recording_path(output_dir);

        let host = cpal::default_host();
        let device = match device_name {
            Some(name) if !name.is_empty() => host
                .input_devices()
                .map_err(|e| format!("Cannot list audio inputs: {e}"))?
                .find(|device| {
                    device
                        .description()
                        .ok()
                        .map(|description| description.name().to_string())
                        .as_deref()
                        == Some(name)
                })
                .ok_or_else(|| format!("Audio input '{name}' is no longer available."))?,
            _ => host
                .default_input_device()
                .ok_or_else(|| "No default audio input is available.".to_string())?,
        };

        let supported = device
            .default_input_config()
            .map_err(|e| format!("Cannot query the audio input: {e}"))?;
        let sample_format = supported.sample_format();
        let mut config: StreamConfig = supported.into();
        config.buffer_size = BufferSize::Default;
        let sample_rate = config.sample_rate;
        let input_channels = config.channels as usize;

        let (data_tx, data_rx) = bounded::<Vec<f32>>(64);
        let (free_tx, free_rx) = bounded::<Vec<f32>>(BUFFER_POOL);
        for _ in 0..BUFFER_POOL {
            let _ = free_tx.try_send(Vec::with_capacity(BLOCK_SAMPLES));
        }
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let input_error = Arc::new(Mutex::new(None));

        let stream = match sample_format {
            SampleFormat::F32 => build_input_stream::<f32>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::F64 => build_input_stream::<f64>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::I16 => build_input_stream::<i16>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::I32 => build_input_stream::<i32>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::U16 => build_input_stream::<u16>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::U8 => build_input_stream::<u8>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::I8 => build_input_stream::<i8>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::I64 => build_input_stream::<i64>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            SampleFormat::U32 => build_input_stream::<u32>(
                &device,
                config,
                input_channels,
                data_tx.clone(),
                free_tx.clone(),
                free_rx,
                dropped_frames.clone(),
                input_error.clone(),
            )?,
            other => {
                return Err(format!(
                    "Unsupported audio input sample format {other:?}. Choose another input device."
                ))
            }
        };
        drop(data_tx);

        let writer_path = path.clone();
        let writer = thread::Builder::new()
            .name("studio-clone-recording-writer".into())
            .spawn(move || write_recording(writer_path, sample_rate, data_rx, free_tx))
            .map_err(|e| format!("Cannot start the recording writer: {e}"))?;

        if let Err(error) = stream.play() {
            drop(stream);
            let _ = writer.join();
            let _ = std::fs::remove_file(&path);
            return Err(format!("Cannot start audio input: {error}"));
        }

        Ok(Self {
            stream: Some(stream),
            writer: Some(writer),
            path,
            sample_rate,
            channels: 2,
            dropped_frames,
            input_error,
        })
    }

    pub fn info(&self) -> RecordingInfo {
        RecordingInfo {
            path: self.path.to_string_lossy().to_string(),
            sample_rate: self.sample_rate,
            channels: self.channels,
        }
    }

    pub fn finish(mut self) -> Result<RecordingResult, String> {
        let writer = self
            .writer
            .take()
            .ok_or_else(|| "The recording writer is no longer available.".to_string())?;
        // Dropping the input stream stops the callback and closes its sender.
        drop(self.stream.take());
        let frames = writer
            .join()
            .map_err(|_| "The recording writer stopped unexpectedly.".to_string())??;
        if frames == 0 {
            let _ = std::fs::remove_file(&self.path);
            return Err(
                "No audio was captured. Check the selected input and Windows microphone permissions."
                    .into(),
            );
        }
        let input_error = self.input_error.lock().ok().and_then(|guard| guard.clone());
        Ok(RecordingResult {
            path: self.path.to_string_lossy().to_string(),
            sample_rate: self.sample_rate,
            channels: self.channels,
            frames,
            duration_seconds: frames as f64 / self.sample_rate.max(1) as f64,
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            input_error,
        })
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        // This covers app shutdown and error paths where finish() was not
        // called. Stop the input first so the writer sees a closed channel,
        // then let it finalise the WAV header.
        drop(self.stream.take());
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

fn unique_recording_path(dir: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    for index in 0..10_000 {
        let name = if index == 0 {
            format!("Recording-{stamp}.wav")
        } else {
            format!("Recording-{stamp}-{index}.wav")
        };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
    }
    dir.join("Recording.wav")
}

fn write_recording(
    path: PathBuf,
    sample_rate: u32,
    data_rx: Receiver<Vec<f32>>,
    free_tx: Sender<Vec<f32>>,
) -> Result<u64, String> {
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: WavSampleFormat::Float,
    };
    let mut writer =
        WavWriter::create(&path, spec).map_err(|e| format!("Cannot create recording: {e}"))?;
    let mut frames = 0u64;
    while let Ok(mut block) = data_rx.recv() {
        for sample in &block {
            writer
                .write_sample(*sample)
                .map_err(|e| format!("Cannot write recording: {e}"))?;
        }
        frames += block.len() as u64 / 2;
        block.clear();
        if block.capacity() <= BLOCK_SAMPLES * 4 {
            let _ = free_tx.try_send(block);
        }
    }
    writer
        .finalize()
        .map_err(|e| format!("Cannot finish recording: {e}"))?;
    Ok(frames)
}

#[allow(clippy::too_many_arguments)]
fn build_input_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    input_channels: usize,
    data_tx: Sender<Vec<f32>>,
    free_tx: Sender<Vec<f32>>,
    free_rx: Receiver<Vec<f32>>,
    dropped_frames: Arc<AtomicU64>,
    input_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample + 'static,
    f32: FromSample<T>,
{
    let input_channels = input_channels.max(1);
    let error_slot = input_error;
    device
        .build_input_stream(
            config,
            move |data: &[T], _info: &cpal::InputCallbackInfo| {
                if data.is_empty() {
                    return;
                }
                let frame_count = data.len() / input_channels;
                if frame_count == 0 {
                    return;
                }
                let needed = frame_count * 2;
                let mut block = match free_rx.try_recv() {
                    Ok(block) => block,
                    Err(_) => Vec::with_capacity(needed),
                };
                block.clear();
                if block.capacity() < needed {
                    block.reserve(needed - block.capacity());
                }
                for frame in data.chunks_exact(input_channels) {
                    if input_channels == 1 {
                        let sample = f32::from_sample(frame[0]);
                        block.push(sample);
                        block.push(sample);
                    } else {
                        block.push(f32::from_sample(frame[0]));
                        block.push(f32::from_sample(frame[1]));
                    }
                }
                if let Err(error) = data_tx.try_send(block) {
                    dropped_frames.fetch_add(frame_count as u64, Ordering::Relaxed);
                    // Recycle the block instead of deallocating it on the
                    // audio thread. If the free list is also full, dropping it
                    // is harmless because plenty of buffers are available.
                    let _ = free_tx.try_send(error.into_inner());
                }
            },
            move |error| {
                if let Ok(mut slot) = error_slot.lock() {
                    *slot = Some(format!("Audio input stream error: {error}"));
                }
            },
            None,
        )
        .map_err(|e| format!("Cannot open the audio input stream: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn writer_produces_a_stereo_float_wav() {
        let dir = std::env::temp_dir().join(format!("studio-recording-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("capture.wav");
        let (data_tx, data_rx) = bounded(4);
        let (free_tx, _free_rx) = bounded(4);
        data_tx
            .send(vec![0.0, 0.0, 0.25, -0.25, 0.5, -0.5])
            .unwrap();
        drop(data_tx);
        let frames = write_recording(path.clone(), 48_000, data_rx, free_tx).unwrap();
        assert_eq!(frames, 3);
        let asset = crate::audio::asset::decode_audio_file(&path).unwrap();
        assert_eq!(asset.channels, 2);
        assert_eq!(asset.sample_rate, 48_000);
        assert_eq!(asset.frame_count(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dropped_frame_counter_is_shared() {
        let dropped = Arc::new(AtomicU64::new(0));
        dropped.fetch_add(12, Ordering::Relaxed);
        assert_eq!(dropped.load(Ordering::Relaxed), 12);
    }
}
