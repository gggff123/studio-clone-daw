import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import type {
  AppInfo,
  AudioDeviceList,
  AudioImportResult,
  AudioOutputResult,
  AutosaveEntry,
  EngineLoadResult,
  ExportOptions,
  ExportProgress,
  ExportResult,
  MediaEntry,
  MidiConnectionStatus,
  MidiDeviceList,
  MidiExportResult,
  MidiImportResult,
  OpenResult,
  Project,
  SaveResult,
  TransportState,
  WaveformResult,
} from "./types";

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  appDataDir: () => call<string>("app_data_dir"),

  getAudioDevices: () => call<AudioDeviceList>("get_audio_devices"),
  setAudioOutput: (name: string | null, sampleRate: number | null) =>
    call<AudioOutputResult>("set_audio_output", { name, sampleRate }),
  setEngineProject: (project: Project) =>
    call<EngineLoadResult>("set_engine_project", { project }),

  transportState: () => call<TransportState>("transport_state"),
  transportPlay: () => call<void>("transport_play"),
  transportPause: () => call<void>("transport_pause"),
  transportStop: () => call<void>("transport_stop"),
  transportSeek: (ticks: number) => call<void>("transport_seek", { ticks }),
  transportReturnToStart: () => call<void>("transport_return_to_start"),
  transportSetLoop: (enabled: boolean, startTicks: number, endTicks: number) =>
    call<void>("transport_set_loop", { enabled, startTicks, endTicks }),

  auditionNote: (trackId: string, note: number, velocity: number, on: boolean) =>
    call<void>("audition_note", { trackId, note, velocity, on }),
  auditionSustain: (trackId: string, down: boolean) =>
    call<void>("audition_sustain", { trackId, down }),
  auditionPitchBend: (trackId: string, value: number) =>
    call<void>("audition_pitch_bend", { trackId, value }),

  importAudio: (path: string) => call<AudioImportResult>("import_audio", { path }),
  getWaveform: (path: string) => call<WaveformResult>("get_waveform", { path }),

  saveProjectFile: (path: string, project: Project) =>
    call<SaveResult>("save_project_file", { path, project }),
  openProjectFile: (path: string) => call<OpenResult>("open_project_file", { path }),
  autosaveProjectFile: (project: Project) =>
    call<{ path: string }>("autosave_project_file", { project }),
  listAutosaveFiles: () => call<AutosaveEntry[]>("list_autosave_files"),
  deleteAutosaveFile: (path: string) => call<void>("delete_autosave_file", { path }),
  loadAutosaveFile: (path: string) => call<OpenResult>("load_autosave_file", { path }),

  exportWav: (project: Project, path: string, options: ExportOptions) =>
    call<ExportResult>("export_wav", { project, path, options }),

  listMedia: (dir: string) => call<MediaEntry[]>("list_media", { dir }),
  defaultMediaDir: () => call<string | null>("default_media_dir"),

  importMidi: (path: string, ppq: number) =>
    call<MidiImportResult>("import_midi", { path, ppq }),
  exportMidi: (project: Project, path: string) =>
    call<MidiExportResult>("export_midi", { project, path }),

  getMidiDevices: () => call<MidiDeviceList>("get_midi_devices"),
  connectMidiInput: (device: string, trackId: string) =>
    call<MidiConnectionStatus>("connect_midi_input", { device, trackId }),
  setMidiInputTarget: (trackId: string) =>
    call<MidiConnectionStatus>("set_midi_input_target", { trackId }),
  disconnectMidiInput: () => call<MidiConnectionStatus>("disconnect_midi_input"),
  getMidiStatus: () => call<MidiConnectionStatus>("get_midi_status"),

  setWindowTitle: (title: string) => call<void>("set_window_title", { title }),
  setWindowSize: (width: number, height: number) =>
    call<void>("set_window_size", { size: { width, height } }),
  quitApp: () => call<void>("quit_app"),
};

export function onExportProgress(
  handler: (progress: ExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ExportProgress>("export-progress", (event) => handler(event.payload));
}

export const fileDialog = {
  async openProject(): Promise<string | null> {
    const selected = await open({
      title: "Open Project",
      multiple: false,
      directory: false,
      filters: [{ name: "Studio Clone Project", extensions: ["cproj"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  async saveProject(defaultPath?: string | null): Promise<string | null> {
    const selected = await save({
      title: "Save Project",
      defaultPath: defaultPath ?? "Untitled Project.cproj",
      filters: [{ name: "Studio Clone Project", extensions: ["cproj"] }],
    });
    return selected ?? null;
  },
  async importAudio(): Promise<string | null> {
    const selected = await open({
      title: "Import Audio",
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "wave", "aif", "aiff", "flac", "mp3", "ogg", "m4a", "aac"],
        },
      ],
    });
    return typeof selected === "string" ? selected : null;
  },
  async importMidi(): Promise<string | null> {
    const selected = await open({
      title: "Import MIDI",
      multiple: false,
      directory: false,
      filters: [{ name: "MIDI", extensions: ["mid", "midi"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  async exportWav(defaultPath: string): Promise<string | null> {
    const selected = await save({
      title: "Export Audio Mixdown",
      defaultPath,
      filters: [{ name: "WAV Audio", extensions: ["wav"] }],
    });
    return selected ?? null;
  },
  async exportMidi(defaultPath: string): Promise<string | null> {
    const selected = await save({
      title: "Export MIDI File",
      defaultPath,
      filters: [{ name: "MIDI", extensions: ["mid"] }],
    });
    return selected ?? null;
  },
  async pickFolder(title = "Choose Folder"): Promise<string | null> {
    const selected = await open({ title, multiple: false, directory: true });
    return typeof selected === "string" ? selected : null;
  },
  async confirm(message: string, title = "Studio Clone"): Promise<boolean> {
    return ask(message, { title, kind: "warning" });
  },
};
