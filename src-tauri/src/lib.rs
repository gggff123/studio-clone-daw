//! Desktop shell for Studio Clone. All audio, MIDI, and project logic lives in
//! the `studio-core` crate so it can be tested without a desktop runtime.

pub use studio_core::{audio, instruments, midi, project};

pub mod commands;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(commands::AppState::new()))
        .setup(|app| {
            use tauri::{LogicalSize, Manager};

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    // Keep the window clear of the taskbar instead of trusting a
                    // fixed design-time size that may be larger than the display.
                    let width = (logical.width * 0.94).clamp(1100.0, 1600.0);
                    let height = (logical.height * 0.86).clamp(640.0, 980.0);
                    let _ = window.set_size(LogicalSize::new(width, height));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_audio_devices,
            commands::set_audio_output,
            commands::set_engine_project,
            commands::transport_state,
            commands::transport_play,
            commands::transport_pause,
            commands::transport_stop,
            commands::transport_seek,
            commands::transport_return_to_start,
            commands::transport_set_loop,
            commands::audition_note,
            commands::audition_sustain,
            commands::audition_pitch_bend,
            commands::import_audio,
            commands::get_waveform,
            commands::save_project_file,
            commands::open_project_file,
            commands::autosave_project_file,
            commands::list_autosave_files,
            commands::delete_autosave_file,
            commands::load_autosave_file,
            commands::export_wav,
            commands::list_media,
            commands::default_media_dir,
            commands::import_midi,
            commands::export_midi,
            commands::get_midi_devices,
            commands::connect_midi_input,
            commands::set_midi_input_target,
            commands::disconnect_midi_input,
            commands::get_midi_status,
            commands::set_window_title,
            commands::app_data_dir,
            commands::set_window_size,
            commands::quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Studio Clone");
}
