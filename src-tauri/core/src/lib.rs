//! Platform-independent core for Studio Clone: project model, audio engine,
//! rendering, MIDI, and instruments. Deliberately free of Tauri so it can be
//! unit-tested without a desktop/webview runtime.

pub mod audio;
pub mod instruments;
pub mod midi;
pub mod project;
