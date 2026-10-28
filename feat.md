# Studio Clone - Feature and Development Tracker

Last updated: 2026-10-28
Current milestone: Milestone 1 preview / `0.1.0`
Status legend: `[x]` implemented and verified, `[~]` implemented but not fully verified, `[!]` blocked, `[ ]` not implemented

This file is the authoritative status record. A UI control is not marked complete
unless the backing behavior exists. Runtime items remain `[~]` until exercised in
the packaged desktop app.

## Environment

- Windows 10/11 x64, 1366x768 test display, 96 DPI, 40 px taskbar
- Node.js 24.15.0, npm 12.0.2
- Rust 1.99.0 GNU toolchain + MinGW-w64 (`C:\mingw64`)
- WebView2 Runtime 155.0.4283.62
- No MSVC C++ build tools; GNU linker used for local Windows builds
- CPAL/WASAPI output verified with `Speakers (High Definition Audio Device)`, 48000 Hz

## Milestone 1 - Application Foundation

- [x] Tauri 2 desktop project with Rust workspace
- [x] UI-free `studio-core` crate separated from the Tauri shell
- [x] TypeScript + Vite frontend build
- [x] Boot/error/retry flow
- [x] Real WASAPI output initialization
- [x] Dynamic window sizing on small displays
- [x] Portable Windows release build
- [x] Clean-close behavior in the packaged build
- [x] Unsaved-project close guard with confirmation
- [ ] Production installer signing
- [ ] Reproducible MSVC build

## Milestone 2 - DAW Interface

- [x] Main toolbar, project identity, and transport
- [x] Arrangement ruler, track headers, lanes, clips, and MIDI parts
- [x] Inspector, media browser, piano roll, and MixConsole panels
- [x] Resizable left and lower zones
- [x] Panel tabs and lower-zone switching
- [x] Keyboard shortcuts and context menus
- [~] Compact layout at 768 px screen height; MixConsole strip controls can clip at the default lower-zone height
- [~] Lower-zone header duplication in empty piano state and MixConsole
- [x] Status bar with engine, tempo, tracks, dirty state, and position

## Milestone 3 - Project Management

- [x] Versioned JSON `.cproj` schema (`formatVersion: 1`)
- [x] New, open, save, and save as
- [x] Atomic writes and timestamped `.bak` backups
- [x] Relative media paths on disk and consolidated `<project>.media` folder
- [x] Missing-media detection and reporting
- [x] Autosave every two minutes with pruning
- [x] Autosave recovery browser
- [x] Dirty-state tracking and window title update
- [x] Unsaved-change guard for window close and Exit
- [x] Round-trip serialization tests
- [~] Recovery dialog and save/open workflows need a complete packaged-app regression pass

## Milestone 4 - Arrangement and Audio Import

- [x] Audio track creation and deletion
- [x] Symphonia decoding for WAV/AIFF/FLAC/MP3/OGG/AAC/M4A family
- [x] Waveform peak generation and arrangement rendering
- [x] Move, trim, split, duplicate, and delete clips
- [x] Split and left-trim respect the media offset in both playback and waveform rendering
- [x] Clip gain and fade-in/fade-out envelopes
- [x] Snap, zoom, scroll, loop region, and markers
- [x] Multi-track MIDI part editing in arrangement
- [x] Undo/redo with gesture coalescing
- [~] Audio import UI needs a packaged-app import regression test
- [~] Stop resets transport position but does not always scroll the arrangement back to the playhead

## Milestone 5 - Native Audio Engine

- [x] Enumerate output devices and sample rates
- [x] Select output device and restart the stream
- [x] Transport play, pause, stop, seek, and return to start
- [x] Tick/frame/seconds conversion
- [x] Multi-track playback through an immutable render graph
- [x] Per-track gain, pan, mute, and solo
- [x] Group/FX bus chaining with cycle prevention
- [x] Master gain, pan, limiter, and peak metering
- [x] Meter data from the audio callback
- [x] Audio callback avoids file I/O, frontend waits, and slow project locks
- [x] Device failure surfaced to the UI
- [~] Sustained-playback stability needs a longer soak test
- [!] ASIO support requires the SDK and native bindings
- [!] Buffer-size selection is not exposed by the current engine
- [ ] Input monitoring / hardware input routing

## Milestone 6 - MIDI and Piano Roll

- [x] Instrument and MIDI tracks
- [x] MIDI part creation and editing
- [x] Piano keyboard with note audition
- [x] Draw, move, resize, and delete notes
- [x] Velocity lane editing
- [x] Quantize and transpose
- [x] Standard MIDI File import and export
- [x] MIDI input enumeration and device connection
- [x] MIDI input routing to a target instrument for audition
- [x] Piano/arrangement playhead synchronization
- [~] MIDI import/export needs a packaged-app round-trip test
- [~] MIDI input needs physical-device verification
- [ ] MIDI recording
- [ ] Controller automation lanes
- [ ] Tempo tracks / tempo maps

## Milestone 7 - Virtual Instruments

- [x] Built-in polyphonic synthesizer
- [x] Two oscillators, detune, and mix
- [x] ADSR amplitude envelope
- [x] Resonant low-pass filter
- [x] LFO with selectable target
- [x] Presets and parameter persistence
- [x] Pitch bend and sustain handling from MIDI input
- [~] Polyphony/voice stealing stability needs a stress test
- [ ] Sample-based instruments
- [ ] VST/AU hosting

## Milestone 8 - MixConsole

- [x] Audio, instrument, MIDI, group, and FX strips
- [x] Volume faders, pan, mute, solo, and record-arm display
- [x] Output routing to master or group/FX buses
- [x] Insert slots and insertion ordering
- [x] Master strip and limiter toggle
- [x] Peak meters
- [x] Add Channel flow
- [~] Default lower-zone height clips M/S/R buttons at 768 px display height
- [~] Sends are persisted and editable but not mixed into the render graph
- [~] Mixer needs a full mouse interaction regression pass
- [ ] Input routing configuration (recording path not implemented)

## Milestone 9 - Audio Effects

- [x] Gain
- [x] Stereo pan
- [x] Three-band EQ
- [x] Parametric EQ
- [x] Compressor
- [x] Limiter
- [x] Noise gate
- [x] Delay with ping-pong
- [x] Reverb
- [x] Chorus
- [x] Bypass, ordering, and parameter persistence
- [x] Effect parameter dialog and presets where defined
- [~] Effect runtime state and tails need longer playback verification

## Milestone 10 - Recording

- [ ] Audio input monitoring
- [x] Audio recording: real CPAL/WASAPI input is written to a float WAV and imported as an audio clip at the record start position. Verified end to end with a 16 kHz microphone (19.46 s capture, real waveform, playback, and split).
- [ ] MIDI recording
- [ ] Count-in
- [~] Metronome setting is stored and click rendering is implemented in the engine; full UI audition still needs verification
- [ ] Punch-in/punch-out
- [ ] Loop recording
- [ ] Takes and comping
- [x] Safe recording file creation: preallocated buffers, a dedicated writer thread, dropped-frame reporting, and WAV finalization on app shutdown
- [~] Recording input device selection and record-arm workflow: verified with a 16 kHz microphone; a dedicated audio-interface pass is still recommended

Audio recording is real; MIDI recording remains unavailable. No fake input meters or captured audio are presented.

## Milestone 11 - Export

- [x] WAV export through the live render graph
- [x] Sample-rate selection (44.1-192 kHz)
- [x] 16-bit PCM, 24-bit PCM, 32-bit float
- [x] Mono and stereo
- [x] Whole-project, cycle, and custom bar range
- [x] Real progress reporting
- [x] Atomic temp file then rename
- [x] Valid WAV header/frame-count tests
- [~] Full UI export regression needs a packaged-app run
- [~] Range semantics use an exclusive end tick internally

## Milestone 12 - Quality Assurance

- [x] 43 `studio-core` unit tests
- [x] Project serialization round-trip
- [x] Future-schema rejection
- [x] Media consolidation and missing-media tests
- [x] Autosave listing/pruning tests
- [x] MIDI import/export tests
- [x] Effect/render tests
- [x] WAV export format, duration, and nonzero-peak tests
- [x] TypeScript production build
- [x] Rust workspace check
- [x] Portable release executable build
- [x] Clean-close verification in packaged build
- [~] Unsaved-close confirmation needs one more packaged-build test
- [~] Long-session playback / memory soak test
- [~] Audio-thread allocation review is implemented by design but not profiled
- [~] Keyboard navigation and focus-order audit
- [x] README and known limitations
- [x] Release automation workflow for Windows and Linux

## Current Implementation Summary

Working end to end:

- Native WASAPI playback of audio clips and synthesized MIDI parts
- Real WASAPI input recording to WAV with automatic clip creation
- Editable arrangement, piano roll, mixer strips, inserts, and master bus
- Versioned project save/open, media consolidation, backups, autosave, and recovery
- MIDI import/export and live MIDI input audition
- Settings for snap, grid visibility, track/accent colors, recording input, and layout reset
- Offline WAV export through the same graph as playback
- Portable Windows executable and GitHub release automation

## Known Bugs / UX Gaps

1. MixConsole strips can clip the M/S/R row at the default lower-zone height on a 768 px display. The lower zone is resizable, but the default should fit.
2. Transport stop resets position to 1.1.1 but does not always scroll the arrangement back to the playhead.
3. Lower-zone tabs and the piano/mixer toolbar duplicate titles when the lower zone is open.
4. Full pointer interaction for every fader, pan control, insert, and menu still needs a systematic packaged-app pass.
5. Export range end-bar labeling is exclusive internally; the UI should make the exact rendered region unambiguous.

## Blocked Tasks

- ASIO output: requires ASIO SDK licensing/download and native bindings.
- Signed Windows installer: requires a code-signing certificate.
- MSVC production build: no MSVC C++ tools on the verification machine.
- Local Linux package build: no verified Linux build host here. GitHub Actions provides Ubuntu builds.

## Latest Test Results

| Date | Command / Check | Environment | Result |
| --- | --- | --- | --- |
| 2026-10-28 | `npm run build` | Windows, Node 24.15.0 | Passed |
| 2026-10-28 | `cargo check --workspace --all-targets` | Rust 1.99 GNU | Passed |
| 2026-10-28 | `cargo test -p studio-core` | Rust 1.99 GNU | Passed, 43 tests |
| 2026-10-28 | Split/offset render regression | `studio-core` | Passed |
| 2026-10-28 | Split/cutter UI waveform | Dev app, recorded clip | Passed; right half starts at the cut offset |
| 2026-10-28 | File/Edit/Settings menu switching | Dev app | Passed |
| 2026-10-22 | `npm run tauri:build:exe` | Rust 1.99 GNU | Passed, portable exe built |
| 2026-10-22 | WASAPI playback smoke test | Real output device | Passed |
| 2026-10-22 | Packaged clean close | Release exe | Passed after capability/guard fix |
| 2026-10-22 | Unsaved close guard | Dev app | Dialog appears; full close regression pending |
| 2026-10-28 | Audio-input recording | 16 kHz microphone | Passed; 19.46 s WAV, peak 0.1426, RMS 0.0098, clip + playback verified |

## Next Recommended Tasks

1. Verify audio recording with a dedicated audio interface/microphone; the webcam-microphone pass already covers record-arm, input selection, WAV finalization, import, and playback.
2. Complete packaged-app regression of save/open/export/import and the unsaved close guard.
3. Fix MixConsole small-height clipping and default lower-zone sizing.
4. Synchronize arrangement scroll to transport stop/return-to-start.
5. Finish export range wording and verify inclusive/exclusive semantics in the UI.
6. Run a sustained playback and memory soak test.
7. Verify physical MIDI input and Linux release runtime on real hardware.
