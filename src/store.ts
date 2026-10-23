import type {
  AppInfo,
  AudioDeviceList,
  AutosaveEntry,
  ExportProgress,
  MasterBus,
  MidiConnectionStatus,
  MidiDeviceList,
  MissingMedia,
  Project,
  TimeSignature,
  Track,
  TrackKind,
  TransportState,
} from "./types";
import { nowIso, uuid } from "./utils/format";

export type StoreEvent =
  | "project"
  | "track"
  | "selection"
  | "layout"
  | "transport"
  | "engine"
  | "ui"
  | "autosaves"
  | "toasts"
  | "waveform";

export interface Selection {
  trackId: string | null;
  clipId: string | null;
  partId: string | null;
  noteIds: string[];
}

export type LeftTab = "inspector" | "media";
export type BottomTab = "piano" | "mixer" | "none";
export type EditTool = "select" | "draw" | "split";
export type ModalType =
  | "audio"
  | "midi"
  | "export"
  | "recovery"
  | "shortcuts"
  | "about"
  | "addTrack"
  | "project"
  | "effect";

export interface ModalState {
  type: ModalType;
  payload?: unknown;
}

export interface LayoutState {
  leftWidth: number;
  bottomHeight: number;
  leftTab: LeftTab;
  bottomTab: BottomTab;
  arrangeZoom: number;
  pianoZoom: number;
  tool: EditTool;
  snapTicks: number;
  trackColor: string;
}

export interface ToastMessage {
  id: number;
  text: string;
  kind: "info" | "success" | "error";
}

export interface AppState {
  ready: boolean;
  bootError: string | null;
  appInfo: AppInfo | null;
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  revision: number;
  selection: Selection;
  layout: LayoutState;
  transport: TransportState | null;
  devices: AudioDeviceList | null;
  midiDevices: MidiDeviceList | null;
  midiStatus: MidiConnectionStatus | null;
  missingMedia: MissingMedia[];
  engineWarnings: string[];
  autosaves: AutosaveEntry[];
  modal: ModalState | null;
  busy: string | null;
  exportProgress: ExportProgress | null;
  toasts: ToastMessage[];
  undoStack: string[];
  redoStack: string[];
  savedAt: number | null;
  lastAutosaveAt: number | null;
}

export function defaultTimeSignature(): TimeSignature {
  return { numerator: 4, denominator: 4 };
}

export function defaultInstrument(): NonNullable<Track["instrument"]> {
  return {
    preset: "Init Saw",
    wave1: "saw",
    wave2: "saw",
    detuneCents: 7,
    oscMix: 0.35,
    attack: 0.008,
    decay: 0.18,
    sustain: 0.72,
    release: 0.28,
    cutoffHz: 3200,
    resonance: 0.18,
    lfoRateHz: 5,
    lfoDepth: 0,
    lfoTarget: "pitch",
    gainDb: -8,
    polyphony: 16,
  };
}

export const DEFAULT_BOTTOM_HEIGHT = 320;
export const MIXER_MIN_BOTTOM_HEIGHT = 300;
export const MIN_BOTTOM_HEIGHT = 168;

export const TRACK_COLORS = [
  "#4f8fce",
  "#67c07a",
  "#c9a227",
  "#c97a4f",
  "#a56fce",
  "#4fc0b7",
  "#ce4f7a",
  "#8a9a5b",
];

export function createTrack(
  kind: TrackKind,
  name: string,
  color: string,
): Track {
  return {
    id: uuid(),
    name,
    kind,
    color,
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    recordArm: false,
    height: 72,
    clips: [],
    parts: [],
    instrument: kind === "instrument" ? defaultInstrument() : null,
    inserts: [],
    sends: [],
    output: "master",
    input: kind === "audio" ? "Stereo In" : "",
  };
}

export function createMasterBus(): MasterBus {
  return { volumeDb: 0, pan: 0, inserts: [], limiter: true };
}

export function createProject(name = "Untitled Project"): Project {
  const timestamp = nowIso();
  return {
    formatVersion: 1,
    id: uuid(),
    name,
    sampleRate: 48_000,
    tempo: 120,
    timeSignature: defaultTimeSignature(),
    ppq: 960,
    tracks: [
      createTrack("instrument", "Instrument 1", TRACK_COLORS[0]),
      createTrack("audio", "Audio 1", TRACK_COLORS[1]),
    ],
    master: createMasterBus(),
    markers: [],
    loopRegion: { enabled: false, startTicks: 0, endTicks: 960 * 16 },
    metronome: false,
    createdAt: timestamp,
    modifiedAt: timestamp,
  };
}

class Store {
  state: AppState;
  private listeners = new Map<StoreEvent, Set<() => void>>();

  constructor() {
    this.state = {
      ready: false,
      bootError: null,
      appInfo: null,
      project: createProject(),
      projectPath: null,
      dirty: false,
      revision: 0,
      selection: { trackId: null, clipId: null, partId: null, noteIds: [] },
      layout: {
        leftWidth: 286,
        bottomHeight: DEFAULT_BOTTOM_HEIGHT,
        leftTab: "inspector",
        bottomTab: "piano",
        arrangeZoom: 64,
        pianoZoom: 12,
        tool: "select",
        snapTicks: 240,
        trackColor: TRACK_COLORS[0],
      },
      transport: null,
      devices: null,
      midiDevices: null,
      midiStatus: null,
      missingMedia: [],
      engineWarnings: [],
      autosaves: [],
      modal: null,
      busy: null,
      exportProgress: null,
      toasts: [],
      undoStack: [],
      redoStack: [],
      savedAt: null,
      lastAutosaveAt: null,
    };
  }

  on(event: StoreEvent, callback: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return () => set?.delete(callback);
  }

  emit(...events: StoreEvent[]): void {
    for (const event of events) {
      const set = this.listeners.get(event);
      if (!set) continue;
      for (const callback of [...set]) {
        try {
          callback();
        } catch (error) {
          console.error(`Store listener for ${event} failed`, error);
        }
      }
    }
  }

  selectedTrack(): Track | null {
    const id = this.state.selection.trackId;
    return this.state.project.tracks.find((track) => track.id === id) ?? null;
  }

  selectedPart(): { track: Track; part: Track["parts"][number] } | null {
    const track = this.selectedTrack();
    const partId = this.state.selection.partId;
    if (!track || !partId) return null;
    const part = track.parts.find((entry) => entry.id === partId);
    return part ? { track, part } : null;
  }
}

export const store = new Store();
export const state = store.state;
