export type TrackKind =
  | "audio"
  | "midi"
  | "instrument"
  | "group"
  | "fx"
  | "marker"
  | "folder";

export type EffectKind =
  | "gain"
  | "pan"
  | "eq3"
  | "parametric"
  | "compressor"
  | "limiter"
  | "noise-gate"
  | "delay"
  | "reverb"
  | "chorus";

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface LoopRegion {
  enabled: boolean;
  startTicks: number;
  endTicks: number;
}

export interface Marker {
  id: string;
  name: string;
  ticks: number;
  color: string;
}

export interface MidiNote {
  id: string;
  pitch: number;
  startTicks: number;
  durationTicks: number;
  velocity: number;
  channel: number;
}

export interface MidiPart {
  id: string;
  name: string;
  startTicks: number;
  durationTicks: number;
  color: string;
  notes: MidiNote[];
}

export interface AudioClip {
  id: string;
  name: string;
  mediaPath: string;
  startTicks: number;
  offsetTicks: number;
  durationTicks: number;
  gainDb: number;
  fadeInTicks: number;
  fadeOutTicks: number;
  color: string;
  mediaSampleRate: number;
}

export interface Send {
  id: string;
  targetTrackId: string;
  levelDb: number;
  preFader: boolean;
  enabled: boolean;
}

export interface InstrumentSettings {
  preset: string;
  wave1: string;
  wave2: string;
  detuneCents: number;
  oscMix: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  cutoffHz: number;
  resonance: number;
  lfoRateHz: number;
  lfoDepth: number;
  lfoTarget: string;
  gainDb: number;
  polyphony: number;
}

export interface InsertEffect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  params: Record<string, number>;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  color: string;
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  recordArm: boolean;
  height: number;
  clips: AudioClip[];
  parts: MidiPart[];
  instrument: InstrumentSettings | null;
  inserts: InsertEffect[];
  sends: Send[];
  output: string;
  input: string;
}

export interface MasterBus {
  volumeDb: number;
  pan: number;
  inserts: InsertEffect[];
  limiter: boolean;
}

export interface Project {
  formatVersion: number;
  id: string;
  name: string;
  sampleRate: number;
  tempo: number;
  timeSignature: TimeSignature;
  ppq: number;
  tracks: Track[];
  master: MasterBus;
  markers: Marker[];
  loopRegion: LoopRegion;
  metronome: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface MeterValue {
  trackId: string;
  peak: number;
}

export interface TransportState {
  playing: boolean;
  recording: boolean;
  positionFrames: number;
  positionTicks: number;
  positionSeconds: number;
  endTicks: number;
  sampleRate: number;
  tempo: number;
  ppq: number;
  loopEnabled: boolean;
  loopStartTicks: number;
  loopEndTicks: number;
  metronome: boolean;
  masterPeak: number;
  meters: MeterValue[];
  outputDevice: string | null;
  engineReady: boolean;
  deviceError: string | null;
}

export interface AudioDeviceInfo {
  name: string;
  isDefault: boolean;
  channels: number;
  defaultSampleRate: number;
  supportedSampleRates: number[];
}

export interface AudioDeviceList {
  outputs: AudioDeviceInfo[];
  inputs: string[];
  currentOutput: string | null;
  error: string | null;
}

export interface DeviceSelection {
  name: string;
  sampleRate: number;
  channels: number;
  sampleFormat: string;
}

export interface AudioOutputResult {
  selection: DeviceSelection;
  missingMedia: string[];
}

export interface EngineLoadResult {
  sampleRate: number;
  outputDevice: string | null;
  trackCount: number;
  missingMedia: string[];
  ready: boolean;
}

export interface AudioImportResult {
  path: string;
  name: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  frames: number;
  peaks: number[];
}

export interface WaveformResult {
  path: string;
  peaks: number[];
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

export interface MissingMedia {
  trackId: string;
  clipId: string;
  mediaPath: string;
}

export interface SaveResult {
  path: string;
  project: Project;
  copiedFiles: string[];
  backupPath: string | null;
}

export interface OpenResult {
  path: string;
  project: Project;
  missingMedia: MissingMedia[];
}

export interface AutosaveEntry {
  path: string;
  projectName: string;
  projectId: string;
  modifiedAt: string;
  size: number;
}

export interface ExportOptions {
  sampleRate: number;
  bitDepth: number;
  channels: number;
  startTicks: number;
  endTicks: number;
}

export interface ExportResult {
  path: string;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  frames: number;
  durationSeconds: number;
  peak: number;
}

export interface ExportProgress {
  progress: number;
  path: string;
}

export interface MediaEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  kind: string;
  modifiedSeconds: number;
}

export interface MidiImportResult {
  name: string;
  parts: MidiPart[];
  tempo: number | null;
  ppq: number;
  durationTicks: number;
  warnings: string[];
}

export interface MidiExportResult {
  path: string;
  tracksWritten: number;
  notesWritten: number;
}

export interface MidiDeviceList {
  inputs: string[];
  outputs: string[];
  error: string | null;
}

export interface MidiConnectionStatus {
  connected: boolean;
  device: string | null;
  targetTrackId: string | null;
  error: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  backendReady: boolean;
  projectFormatVersion: number;
}
