# Changelog

All notable changes to Studio Clone are recorded here. The project uses semantic
versioning for application releases; the project-file schema has its own version.

## [0.1.0] - 2026-10-22

## Added

- Tauri 2 desktop application with a React-free TypeScript UI and Rust backend.
- Arrangement with audio, instrument, MIDI, group, and FX tracks.
- MIDI parts, audio clips, waveform previews, trim/split/duplicate, clip gain,
  fades, snapping, loop region, and markers.
- Piano roll with note drawing, move/resize, velocity editing, quantize,
  transpose, and synth audition.
- MixConsole strips with volume, pan, mute, solo, output routing, inserts,
  master limiter, and real peak meters.
- Ten built-in insert effects: gain, pan, 3-band EQ, parametric EQ, compressor,
  limiter, noise gate, delay, reverb, and chorus.
- Polyphonic dual-oscillator instrument with filter, ADSR, LFO, and presets.
- CPAL/WASAPI playback and device selection.
- Versioned `.cproj` project files, atomic saves, backups, media consolidation,
  missing-media detection, autosave, and recovery.
- Standard MIDI File import/export and MIDI input audition routing.
- WAV mixdown through the same render graph used for playback, with 16-bit PCM,
  24-bit PCM, 32-bit float, mono/stereo, and project/cycle/custom ranges.
- Windows portable release build and GitHub Actions build/release workflows.

### Fixed

- Window could not be closed after confirming an unsaved-project discard. The
  WebView2 `beforeunload` guard was cancelling `Window.destroy()`, and the Tauri
  capability set lacked `core:window:allow-destroy`.
- Piano roll empty state could leave the grid hidden after selecting a part.

### Known issues

- MixConsole can clip its M/S/R row at the default lower-zone height on a
  768 px-tall display.
- Stop resets transport position but may not scroll the arrangement back to the
  playhead.
- Lower-zone titles are duplicated between the panel tab bar and panel toolbar.
- No recording, ASIO, tempo maps, sends mixing, controller automation, or plug-in
  hosting yet.
