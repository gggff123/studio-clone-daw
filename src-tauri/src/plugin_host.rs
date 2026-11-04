//! Native VST3 editor windows.
//!
//! A `PluginWindow` owns a platform window handle and is therefore not `Send`.
//! All editor operations are funnelled through the Tauri main thread; the
//! global map exists only so the main-thread service tick and commands can find
//! an already-open window. The `unsafe impl Send` is sound under that
//! discipline: every access below happens on the main thread.

use crate::commands::SharedState;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use studio_core::audio::plugins::PluginWindow;

struct SendWindow(PluginWindow);

// SAFETY: `PluginWindow` is only ever created, used and dropped on the Tauri
// main thread. The wrapper exists so the window can live in a global map that
// is technically reachable from other threads; no other thread touches it.
unsafe impl Send for SendWindow {}

fn editors() -> &'static Mutex<HashMap<String, SendWindow>> {
    static EDITORS: OnceLock<Mutex<HashMap<String, SendWindow>>> = OnceLock::new();
    EDITORS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_editors() -> MutexGuard<'static, HashMap<String, SendWindow>> {
    editors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Pump native window messages and reap editors the user closed. Runs on the
/// Tauri main thread from a periodic tick.
pub fn service() {
    let mut map = lock_editors();
    let mut closed = Vec::new();
    for (id, window) in map.iter() {
        if window.0.closed_by_user() {
            closed.push(id.clone());
            continue;
        }
        if let Err(err) = window.0.service_platform_events() {
            eprintln!("VST3 editor service failed for {id}: {err}");
        }
    }
    for id in closed {
        if let Some(mut window) = map.remove(&id) {
            window.0.close();
        }
    }
}

/// Open an editor for an already-loaded insert. Must run on the main thread.
pub fn open(state: &SharedState, insert_id: &str) -> Result<(), String> {
    service();
    if lock_editors().contains_key(insert_id) {
        return Ok(());
    }
    let arc = {
        let manager = state
            .plugins
            .lock()
            .map_err(|_| "The plug-in manager lock was poisoned.".to_string())?;
        manager
            .editor_arc(insert_id)
            .ok_or_else(|| "The plug-in is not loaded yet.".to_string())?
    };
    let mut window = PluginWindow::new(arc);
    window
        .open()
        .map_err(|err| format!("Cannot open the plug-in editor: {err}"))?;
    lock_editors().insert(insert_id.to_string(), SendWindow(window));
    Ok(())
}

/// Close one editor. Must run on the main thread.
pub fn close(insert_id: &str) {
    service();
    if let Some(mut window) = lock_editors().remove(insert_id) {
        window.0.close();
    }
}

/// Close every editor, for example when opening another project. Must run on
/// the main thread.
pub fn close_all() {
    let drained: Vec<(String, SendWindow)> = lock_editors().drain().collect();
    for (_, mut window) in drained {
        window.0.close();
    }
}
