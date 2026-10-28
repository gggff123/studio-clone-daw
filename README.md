# Studio Clone

A compact, Cubase Pro 12-inspired desktop DAW built with **Tauri 2**, **Rust**, **TypeScript**, and **Vite**. It is an original implementation: no Steinberg code, binaries, or assets are used.

Studio Clone is a working desktop audio application, not a UI mock-up. The same Rust audio graph renders live playback and offline WAV mixdowns.

> **Project status:** early `0.1.0` preview. Core arrangement, MIDI editing, mixing, project persistence, WAV export, and audio-input recording work. MIDI recording and ASIO are not implemented yet. See [Known limitations](#known-limitations).

## Download

Prebuilt Windows releases are available on the [Releases page](https://github.com/gggff123/studio-clone-daw/releases).

Linux packages (`.AppImage` and `.deb`) are built by the release workflow on Ubuntu. They can also be built locally with the commands below.

## Features

### Arrangement

- Audio, instrument, MIDI, group, and FX tracks
- MIDI parts and audio clips with move, trim, split, duplicate, and delete
- Clip gain and fade-in/fade-out envelopes
- Timeline ruler, loop region, markers, zoom, snapping, and playhead
- Waveform previews generated from decoded audio, including correct split/trim offsets
- Snapshot-based undo/redo with drag gesture coalescing
- Settings menu and Preferences dialog for snap grid, grid visibility, default track color, UI accent color, recording input, and layout reset

### Piano roll and MIDI

- Draw, move, resize, and delete notes
- Velocity lane with per-note editing
- Quantize and transpose selected notes
- Note audition through the built-in synthesizer
- Standard MIDI File import and export
- MIDI input device discovery and routing to an instrument track for live audition

### Mixer, instruments, and effects

- Channel strips with volume, pan, mute, solo, record-arm state, and peak meters
- Master strip with limiter
- Group/FX bus routing with cycle prevention
- Insert effects: gain, stereo pan, 3-band EQ, parametric EQ, compressor, limiter, noise gate, delay, reverb, and chorus
- Built-in polyphonic dual-oscillator synthesizer with filter, ADSR, and LFO controls
- Instrument presets and parameter persistence

### Audio engine

- Native CPAL input and output using WASAPI on Windows
- Output device and sample-rate selection, plus recording input selection
- Real-time transport with seek, pause, stop, and loop playback
- Real CPAL/WASAPI audio-input recording to stereo float WAV, with record-arm targeting, automatic clip creation, and a non-blocking preallocated buffer/writer pipeline
- Multi-track rendering with gain, pan, fades, inserts, bus routing, master limiter, and metering
- Peak meters fed from the actual audio callback
- WAV mixdown through the same render graph used for playback: 16-bit PCM, 24-bit PCM, or 32-bit float; mono or stereo; whole-project, cycle, or custom range

### Project and workflow

- Versioned JSON `.cproj` project format (`formatVersion: 1`)
- Atomic saves and timestamped `.bak` backups
- Media consolidation into `<project name>.media` with relative paths on disk
- Missing-media detection after open and audio-device changes
- Autosave every two minutes, recovery browser, and automatic cleanup of old autosaves
- Resizable inspector, media browser, piano roll, and MixConsole
- Keyboard shortcuts, context menus, and a close guard for unsaved projects

## Requirements

### Running a release

- Windows 10/11 x64
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on current Windows 10/11)
- A working Windows audio output device

### Building from source

Verified environment:

- Windows 10/11 x64
- Node.js `24.15.0`, npm `12.0.2`
- Rust `1.99.0` GNU toolchain with MinGW-w64 (`C:\mingw64`)
- WebView2 Runtime `155.0.4283.62`

Other recent Node.js 20+ and stable Rust toolchains should work, but they have not been verified.

## Getting started

```powershell
git clone https://github.com/gggff123/studio-clone-daw.git
cd studio-clone-daw
npm install
npm run tauri:dev
```

`npm run tauri:dev` starts Vite on `http://localhost:1420` and launches the desktop app.

## Build

Portable Windows executable (verified):

```powershell
npm run tauri:build:exe
# Output: src-tauri\target\release\studio-clone.exe
```

Full Windows installer bundle (requires NSIS/Tauri bundling support):

```powershell
npm run tauri:build
```

Frontend-only production build:

```powershell
npm run build
```

Linux build on Ubuntu 22.04+:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
npm ci
npm run tauri:build
# AppImage/deb output under src-tauri/target/release/bundle/
```

## Tests and checks

```powershell
# TypeScript type-check and Vite production build
npm run build

# Rust workspace check (all targets)
npm run check:rust

# UI-free core tests: project format, media, MIDI, render, effects, export
npm run test:rust
```

The Rust tests live in `src-tauri/core` (`studio-core`). They are intentionally independent of Tauri/WebView2 so they can run on machines without a desktop runtime.

## Project files

- Project container: JSON `.cproj`
- Schema version: `1`
- Autosaves: `%LOCALAPPDATA%\StudioClone\autosave`
- Media: consolidated into a sibling `<project stem>.media` folder on save
- Backups: timestamped `<project>.cproj.<timestamp>.bak` files

A project file opened from a newer unsupported schema version is rejected instead of being silently downgraded.

## Architecture

```text
src/                        TypeScript UI, store, actions, Tauri API wrappers
src-tauri/src/              Tauri desktop shell and commands
src-tauri/core/             UI-free studio-core crate
  audio/                    decoding, render graph, engine, effects, WAV export
  instruments/              polyphonic synthesizer
  midi/                     SMF import/export and input devices
  project/                  schema, time conversion, atomic serialization, autosave
```

The audio callback never waits for the frontend, performs file I/O, or takes slow project locks. The project is compiled into an immutable render graph and swapped atomically; the frontend polls transport and meter snapshots.

## Known limitations

- **Audio recording is implemented; MIDI recording is not.** Audio is captured from the selected CPAL/WASAPI input to a stereo float WAV and placed on the armed audio track. Verified with a 16 kHz microphone; a dedicated audio-interface pass is still recommended.
- **Input monitoring is not implemented.** Recorded input is not routed back to the output while recording.
- **ASIO is not implemented.** Windows input/output uses CPAL/WASAPI. Buffer-size selection is not exposed.
- **Sends are stored but not mixed.** Group/FX bus routing is functional; send-level mixing is not.
- **Tempo is constant.** Tempo changes during playback and tempo maps are not supported yet.
- **MIDI controller automation is not implemented.** Note velocity and instrument parameters are supported.
- **Plug-in support is built-in only.** VST/AU hosting is not implemented.
- **Linux builds are not locally verified here.** CI provides Ubuntu build jobs; package runtime behavior still needs testing on real Linux desktops.
- **No physical audio/MIDI hardware verification** has been performed beyond the default WASAPI output device.
- **The Windows release is a portable executable**, not a signed installer. Windows SmartScreen may warn about an unsigned binary.
- **No auto-update.**

## Release process

See [`RELEASING.md`](RELEASING.md). Release builds are produced by GitHub Actions for Windows and Ubuntu. Tags follow semantic versioning (`v0.1.0`).

## Legal

Studio Clone is an independent project and is **not affiliated with or endorsed by Steinberg Media Technologies GmbH**. “Cubase” is a trademark of its respective owner and is referenced only to describe the interface inspiration.

No proprietary Steinberg code, binaries, presets, or other assets are included in this repository.
