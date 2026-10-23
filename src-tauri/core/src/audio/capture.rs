use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct AudioCapture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
}

impl AudioCapture {
    pub fn start(device_name: Option<&str>) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = match device_name {
            Some(name) if !name.is_empty() => host
                .input_devices()
                .map_err(|e| format!("Cannot list audio inputs: {e}"))?
                .find(|device| device.description().ok().map(|d| d.name().to_string()).as_deref() == Some(name))
                .ok_or_else(|| format!("Audio input '{name}' is no longer available."))?,
            _ => host.default_input_device().ok_or_else(|| "No default audio input is available.".to_string())?,
        };
        let supported = device.default_input_config().map_err(|e| format!("Cannot query audio input: {e}"))?;
        if supported.sample_format() != SampleFormat::F32 {
            return Err(format!("Audio input format {:?} is not supported for recording yet; choose a 32-bit float input.", supported.sample_format()));
        }
        let config: StreamConfig = supported.into();
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        let samples = Arc::new(Mutex::new(Vec::new()));
        let captured = samples.clone();
        let stream = device.build_input_stream(
            config,
            move |input: &[f32], _| {
                if let Ok(mut output) = captured.lock() {
                    output.extend_from_slice(input);
                }
            },
            |error| eprintln!("Audio recording input error: {error}"),
            None,
        ).map_err(|e| format!("Cannot open audio input: {e}"))?;
        stream.play().map_err(|e| format!("Cannot start audio input: {e}"))?;
        Ok(Self { stream, samples, sample_rate, channels })
    }

    pub fn finish(self, path: &Path) -> Result<u64, String> {
        let Self { stream, samples, sample_rate, channels } = self;
        drop(stream);
        let samples = samples.lock().map_err(|_| "Audio recording buffer lock failed.".to_string())?;
        if samples.is_empty() { return Err("No audio was captured. Check the selected input and permissions.".into()); }
        let spec = hound::WavSpec { channels, sample_rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut writer = hound::WavWriter::create(path, spec).map_err(|e| format!("Cannot create recording: {e}"))?;
        for sample in samples.iter() {
            writer.write_sample(sample.clamp(-1.0, 1.0)).map_err(|e| format!("Cannot write recording: {e}"))?;
        }
        writer.finalize().map_err(|e| format!("Cannot finish recording: {e}"))?;
        Ok(samples.len() as u64 / channels.max(1) as u64)
    }
}
