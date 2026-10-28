use crate::audio::asset::{import_result, AssetCache, AudioImportResult};
use crate::audio::capture::{AudioCapture, RecordingInfo, RecordingResult};
use crate::audio::engine::{
    AudioDeviceList, DeviceSelection, TransportState,
};
use crate::audio::export::{export_project_wav, ExportOptions, ExportResult};
use crate::midi::devices::{
    list_midi_devices, MidiConnectionStatus, MidiDeviceList, MidiInputManager,
};
use crate::midi::files::{export_midi_file, import_midi_file, MidiExportResult, MidiImportResult};
use crate::project::serialization::{
    autosave_project, delete_autosave, list_autosaves, load_project, save_project, AutosaveEntry,
    OpenResult, SaveResult,
};
use crate::project::Project;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub engine: Mutex<crate::audio::engine::AudioEngine>,
    pub assets: Mutex<AssetCache>,
    pub last_project: Mutex<Option<Project>>,
    pub midi: Mutex<MidiInputManager>,
    pub recording: Mutex<Option<AudioCapture>>,
    pub autosave_dir: PathBuf,
    pub recordings_dir: PathBuf,
}

impl AppState {
    pub fn new() -> Self {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join("StudioClone");
        Self {
            engine: Mutex::new(crate::audio::engine::AudioEngine::new()),
            assets: Mutex::new(AssetCache::default()),
            last_project: Mutex::new(None),
            midi: Mutex::new(MidiInputManager::default()),
            recording: Mutex::new(None),
            autosave_dir: base.join("autosave"),
            recordings_dir: base.join("recordings"),
        }
    }
}

pub type SharedState = Arc<AppState>;

fn lock_engine(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, crate::audio::engine::AudioEngine>, String> {
    state
        .engine
        .lock()
        .map_err(|_| "The audio engine lock was poisoned.".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    os: String,
    arch: String,
    backend_ready: bool,
    project_format_version: u32,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Studio Clone".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        backend_ready: true,
        project_format_version: crate::project::FORMAT_VERSION,
    }
}

#[tauri::command]
pub fn get_audio_devices(state: State<'_, SharedState>) -> Result<AudioDeviceList, String> {
    let engine = lock_engine(&state)?;
    Ok(engine.list_devices())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputResult {
    pub selection: DeviceSelection,
    pub missing_media: Vec<String>,
}

#[tauri::command]
pub fn set_audio_output(
    state: State<'_, SharedState>,
    name: Option<String>,
    sample_rate: Option<u32>,
) -> Result<AudioOutputResult, String> {
    let mut engine = lock_engine(&state)?;
    let selection = engine.set_output_device(name, sample_rate)?;
    let project = state
        .last_project
        .lock()
        .map_err(|_| "Project state lock failed.".to_string())?
        .clone();
    let missing_media = if let Some(project) = project {
        let mut assets = state
            .assets
            .lock()
            .map_err(|_| "Audio asset cache lock failed.".to_string())?;
        engine.load_project(&project, &mut assets).missing_media
    } else {
        Vec::new()
    };
    Ok(AudioOutputResult {
        selection,
        missing_media,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLoadResult {
    pub sample_rate: u32,
    pub output_device: Option<String>,
    pub track_count: usize,
    pub missing_media: Vec<String>,
    pub ready: bool,
}

#[tauri::command]
pub async fn set_engine_project(
    state: State<'_, SharedState>,
    project: Project,
) -> Result<EngineLoadResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut engine = lock_engine(&state)?;
        let mut assets = state
            .assets
            .lock()
            .map_err(|_| "Audio asset cache lock failed.".to_string())?;
        let built = engine.load_project(&project, &mut assets);
        let state_now = engine.state();
        let track_count = built.track_count;
        *state
            .last_project
            .lock()
            .map_err(|_| "Project state lock failed.".to_string())? = Some(project);
        Ok(EngineLoadResult {
            sample_rate: state_now.sample_rate,
            output_device: state_now.output_device,
            track_count,
            missing_media: built.missing_media,
            ready: state_now.engine_ready,
        })
    })
    .await
    .map_err(|e| format!("Audio engine task failed: {e}"))?
}

#[tauri::command]
pub fn transport_state(state: State<'_, SharedState>) -> Result<TransportState, String> {
    let engine = lock_engine(&state)?;
    Ok(engine.state())
}

#[tauri::command]
pub fn transport_play(state: State<'_, SharedState>) -> Result<(), String> {
    lock_engine(&state)?.play();
    Ok(())
}

#[tauri::command]
pub fn transport_pause(state: State<'_, SharedState>) -> Result<(), String> {
    lock_engine(&state)?.pause();
    Ok(())
}

#[tauri::command]
pub fn transport_stop(state: State<'_, SharedState>) -> Result<(), String> {
    lock_engine(&state)?.stop();
    Ok(())
}

#[tauri::command]
pub fn transport_seek(state: State<'_, SharedState>, ticks: u64) -> Result<(), String> {
    lock_engine(&state)?.seek_ticks(ticks);
    Ok(())
}

#[tauri::command]
pub fn start_audio_recording(
    state: State<'_, SharedState>,
    device: Option<String>,
    start_ticks: u64,
) -> Result<RecordingInfo, String> {
    let mut slot = state
        .recording
        .lock()
        .map_err(|_| "Recording state lock was poisoned.".to_string())?;
    if slot.is_some() {
        return Err("Recording is already active.".into());
    }
    let capture = AudioCapture::start(device.as_deref(), &state.recordings_dir)?;
    let info = capture.info();
    {
        let engine = lock_engine(&state)?;
        engine.seek_ticks(start_ticks);
        engine.set_recording(true);
        engine.play();
    }
    *slot = Some(capture);
    Ok(info)
}

#[tauri::command]
pub fn stop_audio_recording(state: State<'_, SharedState>) -> Result<RecordingResult, String> {
    let capture = state
        .recording
        .lock()
        .map_err(|_| "Recording state lock was poisoned.".to_string())?
        .take()
        .ok_or_else(|| "No audio recording is active.".to_string())?;
    let result = capture.finish();
    if let Ok(engine) = state.engine.lock() {
        engine.stop();
        engine.set_recording(false);
    }
    result
}

#[tauri::command]
pub fn transport_return_to_start(state: State<'_, SharedState>) -> Result<(), String> {
    lock_engine(&state)?.return_to_start();
    Ok(())
}

#[tauri::command]
pub fn transport_set_loop(
    state: State<'_, SharedState>,
    enabled: bool,
    start_ticks: u64,
    end_ticks: u64,
) -> Result<(), String> {
    lock_engine(&state)?.set_loop(enabled, start_ticks, end_ticks);
    Ok(())
}

#[tauri::command]
pub fn audition_note(
    state: State<'_, SharedState>,
    track_id: String,
    note: u8,
    velocity: u8,
    on: bool,
) -> Result<(), String> {
    lock_engine(&state)?.audition_note(&track_id, note, velocity, on);
    Ok(())
}

#[tauri::command]
pub fn audition_sustain(
    state: State<'_, SharedState>,
    track_id: String,
    down: bool,
) -> Result<(), String> {
    lock_engine(&state)?.audition_sustain(&track_id, down);
    Ok(())
}

#[tauri::command]
pub fn audition_pitch_bend(
    state: State<'_, SharedState>,
    track_id: String,
    value: f32,
) -> Result<(), String> {
    lock_engine(&state)?.audition_pitch_bend(&track_id, value);
    Ok(())
}

#[tauri::command]
pub async fn import_audio(
    state: State<'_, SharedState>,
    path: String,
) -> Result<AudioImportResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut assets = state
            .assets
            .lock()
            .map_err(|_| "Audio asset cache lock failed.".to_string())?;
        let asset = assets.load(Path::new(&path))?;
        Ok(import_result(&asset))
    })
    .await
    .map_err(|e| format!("Audio import task failed: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformResult {
    pub path: String,
    pub peaks: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_seconds: f64,
}

#[tauri::command]
pub async fn get_waveform(
    state: State<'_, SharedState>,
    path: String,
) -> Result<WaveformResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut assets = state
            .assets
            .lock()
            .map_err(|_| "Audio asset cache lock failed.".to_string())?;
        let asset = assets.load(Path::new(&path))?;
        Ok(WaveformResult {
            path: asset.path.to_string_lossy().to_string(),
            peaks: asset.peaks.clone(),
            sample_rate: asset.sample_rate,
            channels: asset.channels,
            duration_seconds: asset.duration_seconds,
        })
    })
    .await
    .map_err(|e| format!("Waveform task failed: {e}"))?
}

#[tauri::command]
pub async fn save_project_file(
    state: State<'_, SharedState>,
    path: String,
    project: Project,
) -> Result<SaveResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = save_project(Path::new(&path), &project)?;
        *state
            .last_project
            .lock()
            .map_err(|_| "Project state lock failed.".to_string())? =
            Some(result.project.clone());
        Ok(result)
    })
    .await
    .map_err(|e| format!("Save task failed: {e}"))?
}

#[tauri::command]
pub async fn open_project_file(
    state: State<'_, SharedState>,
    path: String,
) -> Result<OpenResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = load_project(Path::new(&path))?;
        *state
            .last_project
            .lock()
            .map_err(|_| "Project state lock failed.".to_string())? =
            Some(result.project.clone());
        Ok(result)
    })
    .await
    .map_err(|e| format!("Open task failed: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveResult {
    pub path: String,
}

#[tauri::command]
pub fn autosave_project_file(
    state: State<'_, SharedState>,
    project: Project,
) -> Result<AutosaveResult, String> {
    let path = autosave_project(&state.autosave_dir, &project)?;
    Ok(AutosaveResult { path })
}

#[tauri::command]
pub fn list_autosave_files(state: State<'_, SharedState>) -> Vec<AutosaveEntry> {
    list_autosaves(&state.autosave_dir)
}

#[tauri::command]
pub fn delete_autosave_file(state: State<'_, SharedState>, path: String) -> Result<(), String> {
    delete_autosave(&state.autosave_dir, &path)
}

#[tauri::command]
pub async fn load_autosave_file(
    state: State<'_, SharedState>,
    path: String,
) -> Result<OpenResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("Autosave file unavailable: {e}"))?;
        let dir = state
            .autosave_dir
            .canonicalize()
            .map_err(|e| format!("Autosave folder unavailable: {e}"))?;
        if !canonical.starts_with(&dir) {
            return Err("Refusing to load a file outside the autosave folder.".into());
        }
        let result = load_project(&canonical)?;
        *state
            .last_project
            .lock()
            .map_err(|_| "Project state lock failed.".to_string())? =
            Some(result.project.clone());
        Ok(result)
    })
    .await
    .map_err(|e| format!("Recovery task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub progress: f32,
    pub path: String,
}

#[tauri::command]
pub async fn export_wav(
    app: AppHandle,
    state: State<'_, SharedState>,
    project: Project,
    path: String,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut assets = state
            .assets
            .lock()
            .map_err(|_| "Audio asset cache lock failed.".to_string())?;
        let progress_path = path.clone();
        export_project_wav(
            &project,
            Path::new(&path),
            &options,
            &mut assets,
            |progress| {
                let _ = app.emit(
                    "export-progress",
                    ExportProgress {
                        progress,
                        path: progress_path.clone(),
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| format!("Export task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub kind: String,
    pub modified_seconds: u64,
}

fn media_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "wav" | "wave" | "aif" | "aiff" | "flac" | "mp3" | "ogg" | "m4a" | "aac" => "audio",
        "mid" | "midi" => "midi",
        "cproj" => "project",
        "json" => "preset",
        _ => "other",
    }
}

#[tauri::command]
pub fn list_media(dir: String) -> Result<Vec<MediaEntry>, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err("The selected media folder is not available.".into());
    }
    let read = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read media folder: {e}"))?;
    let mut entries: Vec<MediaEntry> = read
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let is_dir = metadata.is_dir();
            let modified_seconds = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(MediaEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                size: if is_dir { 0 } else { metadata.len() },
                kind: if is_dir {
                    "folder".into()
                } else {
                    media_kind(&path).into()
                },
                modified_seconds,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn default_media_dir() -> Option<String> {
    dirs::audio_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn import_midi(
    path: String,
    ppq: u32,
) -> Result<MidiImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_midi_file(Path::new(&path), ppq))
        .await
        .map_err(|e| format!("MIDI import task failed: {e}"))?
}

#[tauri::command]
pub async fn export_midi(
    project: Project,
    path: String,
) -> Result<MidiExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_midi_file(&project, Path::new(&path)))
        .await
        .map_err(|e| format!("MIDI export task failed: {e}"))?
}

#[tauri::command]
pub fn get_midi_devices() -> MidiDeviceList {
    list_midi_devices()
}

#[tauri::command]
pub fn connect_midi_input(
    state: State<'_, SharedState>,
    device: String,
    track_id: String,
) -> Result<MidiConnectionStatus, String> {
    let sender = {
        let engine = lock_engine(&state)?;
        engine.live_sender()
    };
    let mut midi = state
        .midi
        .lock()
        .map_err(|_| "MIDI state lock failed.".to_string())?;
    midi.connect(&device, &track_id, sender)?;
    Ok(midi.status())
}

#[tauri::command]
pub fn set_midi_input_target(
    state: State<'_, SharedState>,
    track_id: String,
) -> Result<MidiConnectionStatus, String> {
    let midi = state
        .midi
        .lock()
        .map_err(|_| "MIDI state lock failed.".to_string())?;
    midi.set_target(&track_id);
    Ok(midi.status())
}

#[tauri::command]
pub fn disconnect_midi_input(
    state: State<'_, SharedState>,
) -> Result<MidiConnectionStatus, String> {
    let mut midi = state
        .midi
        .lock()
        .map_err(|_| "MIDI state lock failed.".to_string())?;
    midi.disconnect();
    Ok(midi.status())
}

#[tauri::command]
pub fn get_midi_status(
    state: State<'_, SharedState>,
) -> Result<MidiConnectionStatus, String> {
    let midi = state
        .midi
        .lock()
        .map_err(|_| "MIDI state lock failed.".to_string())?;
    Ok(midi.status())
}

#[tauri::command]
pub fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_data_dir(state: State<'_, SharedState>) -> String {
    state
        .autosave_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_string_lossy()
        .to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn set_window_size(window: tauri::Window, size: WindowSize) -> Result<(), String> {
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: size.width.max(900.0),
            height: size.height.max(600.0),
        }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[allow(dead_code)]
fn _state_type(_: &AppState) {}
