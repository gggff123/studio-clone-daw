//! VST3 plug-in hosting.
//!
//! Plug-ins themselves are **not** part of the serializable project model: a
//! [`Plugin`] owns native objects and cannot be cloned or written to JSON. The
//! project stores only a [`PluginRef`] plus the plug-in's opaque state blob.
//! [`PluginManager`] owns the live instances on the control thread and hands
//! `Arc` handles to the render graph. The manager keeps a strong reference for
//! as long as an instance is used by any graph, plus a short retirement grace
//! period, so the audio callback can never be the last owner of a plug-in.
//!
//! Scanning uses `read_module_info`, which parses the bundle's `moduleinfo.json`
//! without executing the plug-in. Bundles without that file are still listed
//! with metadata derived from the file name; they are only loaded when the user
//! actually inserts them.

use crate::project::{EffectKind, InsertEffect, PluginRef, Project};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use vst3_host::discovery::{read_module_info, scan_directories, scan_standard_paths};
pub use vst3_host::PluginWindow;
use vst3_host::{AudioBuffers, Plugin, ProcessMode, Vst3Host};

/// Block size requested from every plug-in. This matches the mixer's maximum
/// block size, so one render callback maps to exactly one `process` call.
pub const PLUGIN_BLOCK_SIZE: usize = crate::audio::render::MAX_BLOCK_FRAMES;

/// How long a replaced/removed instance is kept alive before it is dropped on
/// the control thread. This lets an in-flight render callback release its
/// `Arc` before the native module is unloaded.
const RETIRE_GRACE: Duration = Duration::from_millis(1_000);

/// A clonable, debug-printable handle to a live plug-in instance.
#[derive(Clone)]
pub struct PluginHandle(Arc<Mutex<Plugin>>);

impl PluginHandle {
    fn new(plugin: Plugin) -> Self {
        Self(Arc::new(Mutex::new(plugin)))
    }

    /// Borrow the underlying instance. Render code uses `try_lock` so a busy
    /// editor can never block the audio callback.
    pub fn arc(&self) -> &Arc<Mutex<Plugin>> {
        &self.0
    }

    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Plugin>, String> {
        self.0
            .lock()
            .map_err(|_| "The plug-in instance lock was poisoned.".to_string())
    }
}

impl std::fmt::Debug for PluginHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginHandle").finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct ManagedPlugin {
    path: String,
    uid: String,
    handle: PluginHandle,
    loaded_at: Instant,
}

#[derive(Debug)]
struct RetiredPlugin {
    /// Kept alive only so the audio callback can never be the last owner.
    #[allow(dead_code)]
    handle: PluginHandle,
    retired_at: Instant,
}

/// One plug-in class advertised by a VST3 bundle.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub path: String,
    pub uid: String,
    pub name: String,
    pub vendor: String,
    pub category: String,
    pub sub_categories: Vec<String>,
    pub is_effect: bool,
    pub is_instrument: bool,
}

impl PluginDescriptor {
    pub fn reference(&self) -> PluginRef {
        PluginRef {
            path: self.path.clone(),
            uid: self.uid.clone(),
            name: self.name.clone(),
            vendor: self.vendor.clone(),
            category: self.category.clone(),
        }
    }
}

/// A serializable plug-in parameter for the fallback editor.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginParameter {
    pub id: u32,
    pub name: String,
    pub value: f64,
    pub default: f64,
    pub unit: String,
    pub display: String,
    pub step_count: i32,
    pub can_automate: bool,
    pub is_read_only: bool,
    pub is_bypass: bool,
}

/// Owns every live VST3 instance used by the current project.
#[derive(Debug)]
pub struct PluginManager {
    sample_rate: u32,
    process_mode: ProcessMode,
    instances: HashMap<String, ManagedPlugin>,
    retired: Vec<RetiredPlugin>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self::new(48_000)
    }
}

impl PluginManager {
    pub fn new(sample_rate: u32) -> Self {
        Self::with_mode(sample_rate, ProcessMode::Realtime)
    }

    /// A manager for faster-than-realtime rendering. Plug-ins can then switch
    /// to their offline quality/look-ahead mode.
    pub fn new_offline(sample_rate: u32) -> Self {
        Self::with_mode(sample_rate, ProcessMode::Offline)
    }

    fn with_mode(sample_rate: u32, process_mode: ProcessMode) -> Self {
        Self {
            sample_rate: if sample_rate == 0 {
                48_000
            } else {
                sample_rate
            },
            process_mode,
            instances: HashMap::new(),
            retired: Vec::new(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Drop all instances on a sample-rate change. Existing graphs keep their
    /// handles alive through the manager's retirement list until they are done.
    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        let sample_rate = if sample_rate == 0 {
            48_000
        } else {
            sample_rate
        };
        if sample_rate == self.sample_rate {
            return;
        }
        self.clear();
        self.sample_rate = sample_rate;
    }

    pub fn clear(&mut self) {
        let drained: Vec<PluginHandle> = self
            .instances
            .drain()
            .map(|(_, instance)| instance.handle)
            .collect();
        for handle in drained {
            self.retire(handle);
        }
        self.prune_retired();
    }

    /// Release instances that are no longer part of the project graph.
    pub fn retain(&mut self, active: &HashSet<String>) {
        let stale: Vec<String> = self
            .instances
            .keys()
            .filter(|id| !active.contains(id.as_str()))
            .cloned()
            .collect();
        for id in stale {
            if let Some(instance) = self.instances.remove(&id) {
                self.retire(instance.handle);
            }
        }
        self.prune_retired();
    }

    fn retire(&mut self, handle: PluginHandle) {
        self.retired.push(RetiredPlugin {
            handle,
            retired_at: Instant::now(),
        });
    }

    fn prune_retired(&mut self) {
        let grace = RETIRE_GRACE;
        self.retired
            .retain(|entry| entry.retired_at.elapsed() < grace);
    }

    /// Return an instance for this insert, loading or restoring it when needed.
    ///
    /// The identity is `(insert.id, path, uid)`. Rebuilds triggered by mixer
    /// edits therefore reuse the same native instance and keep tails/voices.
    pub fn ensure_plugin(&mut self, insert: &InsertEffect) -> Result<PluginHandle, String> {
        let reference = insert
            .plugin
            .as_ref()
            .ok_or_else(|| "This insert has no VST3 plug-in reference.".to_string())?;
        if reference.path.trim().is_empty() {
            return Err("The plug-in path is empty.".to_string());
        }
        if insert.id.trim().is_empty() {
            return Err("The plug-in insert has no id.".to_string());
        }

        if let Some(existing) = self.instances.get(&insert.id) {
            if paths_match(&existing.path, &reference.path) && existing.uid == reference.uid {
                return Ok(existing.handle.clone());
            }
        }
        if let Some(old) = self.instances.remove(&insert.id) {
            self.retire(old.handle);
        }

        let path = PathBuf::from(&reference.path);
        if !path.exists() {
            return Err(format!("Plug-in not found: {}", reference.path));
        }

        let mut host = Vst3Host::builder()
            .sample_rate(self.sample_rate as f64)
            .block_size(PLUGIN_BLOCK_SIZE)
            .input_channels(2)
            .output_channels(2)
            .build()
            .map_err(|err| format!("Cannot create the VST3 host: {err}"))?;

        let mut plugin = if is_class_uid(&reference.uid) {
            match host.load_plugin_class(&path, &reference.uid) {
                Ok(plugin) => plugin,
                Err(first_error) => host.load_plugin(&path).map_err(|second_error| {
                    format!(
                        "Cannot load {}: {first_error}; default class also failed: {second_error}",
                        reference.display_name()
                    )
                })?,
            }
        } else {
            host.load_plugin(&path)
                .map_err(|err| format!("Cannot load {}: {err}", reference.display_name()))?
        };

        if !insert.state.trim().is_empty() {
            match BASE64.decode(insert.state.trim()) {
                Ok(bytes) if !bytes.is_empty() => {
                    if let Err(err) = plugin.load_state(&bytes) {
                        eprintln!(
                            "VST3 state restore failed for {}: {err}",
                            reference.display_name()
                        );
                    }
                }
                _ => eprintln!(
                    "VST3 state for {} is not valid base64; starting from defaults.",
                    reference.display_name()
                ),
            }
        }

        if self.process_mode != ProcessMode::Realtime {
            // Some plug-ins do not implement offline mode; they still render
            // correctly in their default real-time mode.
            if let Err(err) = plugin.set_process_mode(self.process_mode) {
                eprintln!(
                    "VST3 offline mode rejected by {}: {err}",
                    reference.display_name()
                );
            }
        }
        plugin
            .start_processing()
            .map_err(|err| format!("Cannot start {}: {err}", reference.display_name()))?;

        let handle = PluginHandle::new(plugin);
        self.instances.insert(
            insert.id.clone(),
            ManagedPlugin {
                path: reference.path.clone(),
                uid: reference.uid.clone(),
                handle: handle.clone(),
                loaded_at: Instant::now(),
            },
        );
        self.prune_retired();
        Ok(handle)
    }

    pub fn handle(&self, insert_id: &str) -> Option<PluginHandle> {
        self.instances
            .get(insert_id)
            .map(|entry| entry.handle.clone())
    }

    /// Strong handle for an editor window. The editor is opened on the main
    /// thread, but the Arc is fetched on whichever thread runs the command.
    pub fn editor_arc(&self, insert_id: &str) -> Option<Arc<Mutex<Plugin>>> {
        self.instances
            .get(insert_id)
            .map(|entry| entry.handle.arc().clone())
    }

    /// Write live plug-in state back into the project before save/export.
    /// Inserts without a loaded instance keep their previous state blob.
    pub fn capture_states(&self, project: &mut Project) {
        for insert in all_inserts_mut(project) {
            if insert.kind != EffectKind::Plugin {
                continue;
            }
            let Some(instance) = self.instances.get(&insert.id) else {
                continue;
            };
            let Ok(plugin) = instance.handle.lock() else {
                continue;
            };
            if let Ok(bytes) = plugin.save_state() {
                if !bytes.is_empty() {
                    insert.state = BASE64.encode(bytes);
                }
            }
        }
    }

    pub fn parameters(&self, insert_id: &str) -> Result<Vec<PluginParameter>, String> {
        let instance = self
            .instances
            .get(insert_id)
            .ok_or_else(|| "The plug-in is not loaded.".to_string())?;
        let plugin = instance.handle.lock()?;
        let params = plugin
            .get_parameters()
            .map_err(|err| format!("Cannot read plug-in parameters: {err}"))?;
        Ok(params
            .into_iter()
            .map(|param| {
                let display = plugin
                    .format_parameter(param.id, param.value)
                    .unwrap_or_else(|_| format!("{:.0}%", param.value * 100.0));
                PluginParameter {
                    id: param.id,
                    name: param.name,
                    value: param.value,
                    default: param.default,
                    unit: param.unit,
                    display,
                    step_count: param.step_count,
                    can_automate: param.can_automate,
                    is_read_only: param.is_read_only,
                    is_bypass: param.is_bypass,
                }
            })
            .collect())
    }

    pub fn set_parameter(
        &self,
        insert_id: &str,
        parameter_id: u32,
        value: f64,
    ) -> Result<(), String> {
        let instance = self
            .instances
            .get(insert_id)
            .ok_or_else(|| "The plug-in is not loaded.".to_string())?;
        let mut plugin = instance.handle.lock()?;
        plugin
            .set_parameter(parameter_id, value.clamp(0.0, 1.0))
            .map_err(|err| format!("Cannot set plug-in parameter: {err}"))
    }

    pub fn has_editor(&self, insert_id: &str) -> bool {
        self.instances
            .get(insert_id)
            .and_then(|entry| entry.handle.lock().ok().map(|plugin| plugin.has_editor()))
            .unwrap_or(false)
    }

    pub fn loaded_count(&self) -> usize {
        self.instances.len()
    }

    pub fn instance_path(&self, insert_id: &str) -> Option<&str> {
        self.instances
            .get(insert_id)
            .map(|entry| entry.path.as_str())
    }

    pub fn instance_uid(&self, insert_id: &str) -> Option<&str> {
        self.instances
            .get(insert_id)
            .map(|entry| entry.uid.as_str())
    }

    pub fn loaded_age(&self, insert_id: &str) -> Option<Duration> {
        self.instances
            .get(insert_id)
            .map(|entry| entry.loaded_at.elapsed())
    }
}

fn all_inserts_mut(project: &mut Project) -> impl Iterator<Item = &mut InsertEffect> {
    project
        .tracks
        .iter_mut()
        .flat_map(|track| track.inserts.iter_mut())
        .chain(project.master.inserts.iter_mut())
}

fn paths_match(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn is_class_uid(uid: &str) -> bool {
    uid.len() == 32 && uid.chars().all(|c| c.is_ascii_hexdigit())
}

/// Discover VST3 bundles in the standard locations plus any user folders.
///
/// This never runs plug-in code: bundles are read via `moduleinfo.json`. A
/// bundle without that file is listed using its file name and neutral metadata.
pub fn scan_plugins(extra_paths: &[String]) -> Vec<PluginDescriptor> {
    let mut roots: Vec<PathBuf> = scan_standard_paths();
    for path in extra_paths {
        let path = path.trim();
        if !path.is_empty() {
            roots.push(PathBuf::from(path));
        }
    }
    roots.sort();
    roots.dedup();

    let bundles = match scan_directories(&roots) {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("VST3 scan failed: {err}");
            return Vec::new();
        }
    };

    let mut descriptors = Vec::new();
    for bundle in bundles {
        match read_module_info(&bundle) {
            Ok(Some(info)) => {
                let fallback_name = bundle_stem(&bundle);
                let module_name = if info.name.trim().is_empty() {
                    fallback_name
                } else {
                    info.name.clone()
                };
                let factory_vendor = info.factory.vendor.clone();
                let mut found_audio_class = false;
                for class in &info.classes {
                    if !class.category.eq_ignore_ascii_case("Audio Module Class") {
                        continue;
                    }
                    let sub_categories: Vec<String> = class
                        .sub_categories
                        .iter()
                        .filter(|value| !value.trim().is_empty())
                        .cloned()
                        .collect();
                    let is_effect = sub_categories
                        .iter()
                        .any(|value| value.eq_ignore_ascii_case("Fx"));
                    let is_instrument = sub_categories
                        .iter()
                        .any(|value| value.eq_ignore_ascii_case("Instrument"));
                    // Classes that declare neither are still usable processors in
                    // practice; expose them as effects instead of hiding them.
                    let is_effect = is_effect || !is_instrument;
                    found_audio_class = true;
                    let name = if class.name.trim().is_empty() {
                        module_name.clone()
                    } else {
                        class.name.clone()
                    };
                    let vendor = if class.vendor.trim().is_empty() {
                        factory_vendor.clone()
                    } else {
                        class.vendor.clone()
                    };
                    descriptors.push(PluginDescriptor {
                        path: bundle.to_string_lossy().to_string(),
                        uid: class.class_id.clone(),
                        name,
                        vendor,
                        category: if is_instrument {
                            "Instrument".to_string()
                        } else {
                            "Effect".to_string()
                        },
                        sub_categories,
                        is_effect,
                        is_instrument,
                    });
                }
                if !found_audio_class {
                    descriptors.push(fallback_descriptor(&bundle, &module_name, &factory_vendor));
                }
            }
            Ok(None) | Err(_) => {
                descriptors.push(fallback_descriptor(&bundle, &bundle_stem(&bundle), ""));
            }
        }
    }

    descriptors.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.vendor.to_lowercase().cmp(&b.vendor.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    descriptors.dedup_by(|a, b| a.path == b.path && a.uid == b.uid);
    descriptors
}

fn fallback_descriptor(bundle: &Path, name: &str, vendor: &str) -> PluginDescriptor {
    PluginDescriptor {
        path: bundle.to_string_lossy().to_string(),
        uid: String::new(),
        name: name.to_string(),
        vendor: vendor.to_string(),
        category: "Effect".to_string(),
        sub_categories: vec!["Fx".to_string()],
        is_effect: true,
        is_instrument: false,
    }
}

fn bundle_stem(bundle: &Path) -> String {
    bundle
        .file_stem()
        .or_else(|| bundle.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "VST3 Plug-in".to_string())
}

/// Scratch buffers for one plug-in insert on the audio thread.
///
/// Reused across blocks; resizing within the preallocated capacity performs no
/// allocation.
pub struct PluginScratch {
    buffers: AudioBuffers,
}

impl PluginScratch {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            buffers: AudioBuffers::new(2, 2, PLUGIN_BLOCK_SIZE, sample_rate as f64),
        }
    }

    /// Process `frames` samples in place. Returns false when the insert should
    /// be bypassed for this block (lock contention, processing error, or a
    /// plug-in that has no stereo output).
    pub fn process(
        &mut self,
        handle: &PluginHandle,
        left: &mut [f32],
        right: &mut [f32],
        frames: usize,
        sample_rate: u32,
    ) -> bool {
        let frames = frames
            .min(left.len())
            .min(right.len())
            .min(PLUGIN_BLOCK_SIZE);
        if frames == 0 {
            return true;
        }
        let Ok(mut plugin) = handle.arc().try_lock() else {
            return false;
        };
        self.buffers.sample_rate = sample_rate as f64;
        for channel in &mut self.buffers.inputs {
            channel.resize(frames, 0.0);
        }
        for channel in &mut self.buffers.outputs {
            channel.resize(frames, 0.0);
        }
        for channel in &mut self.buffers.outputs {
            channel.fill(0.0);
        }
        self.buffers.inputs[0][..frames].copy_from_slice(&left[..frames]);
        self.buffers.inputs[1][..frames].copy_from_slice(&right[..frames]);
        if plugin.process_audio(&mut self.buffers).is_err() {
            return false;
        }
        if self.buffers.outputs.len() < 2 {
            return false;
        }
        left[..frames].copy_from_slice(&self.buffers.outputs[0][..frames]);
        right[..frames].copy_from_slice(&self.buffers.outputs[1][..frames]);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_uid_validation() {
        assert!(is_class_uid("0123456789abcdef0123456789ABCDEF"));
        assert!(!is_class_uid(""));
        assert!(!is_class_uid("not-a-uid"));
        assert!(!is_class_uid("0123456789abcdef0123456789abcde"));
    }

    #[test]
    fn capture_states_keeps_existing_blob_without_instance() {
        let mut project = Project::new("Plugins");
        let mut insert = InsertEffect {
            id: "fx".into(),
            kind: EffectKind::Plugin,
            enabled: true,
            params: Default::default(),
            plugin: Some(PluginRef {
                path: "missing.vst3".into(),
                uid: String::new(),
                name: "Missing".into(),
                vendor: String::new(),
                category: "Effect".into(),
            }),
            state: "cHJlc2VydmVk".into(),
        };
        insert.enabled = false;
        project.master.inserts.push(insert);
        let manager = PluginManager::new(48_000);
        manager.capture_states(&mut project);
        assert_eq!(project.master.inserts[0].state, "cHJlc2VydmVk");
    }
}
