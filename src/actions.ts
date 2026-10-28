import { api, fileDialog, onExportProgress } from "./api";
import {
  createProject,
  createTrack,
  DEFAULT_BOTTOM_HEIGHT,
  defaultInstrument,
  MIN_BOTTOM_HEIGHT,
  state,
  store,
  TRACK_COLORS,
  type ModalType,
  type Selection,
  type StoreEvent,
} from "./store";
import type {
  AudioClip,
  AudioImportResult,
  EffectKind,
  ExportOptions,
  ExportResult,
  InsertEffect,
  InstrumentSettings,
  MidiImportResult,
  MidiNote,
  MidiPart,
  MissingMedia,
  Project,
  Track,
  TrackKind,
} from "./types";
import { createInsert } from "./ui/effects";
import {
  clamp,
  fileStem,
  nowIso,
  projectEndTicks,
  uuid,
} from "./utils/format";

type Emit = StoreEvent | StoreEvent[];

const MAX_UNDO = 60;

function serialize(project: Project): string {
  return JSON.stringify(project);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class HistoryController {
  private undoSnapshots: string[] = [];
  private redoSnapshots: string[] = [];
  private pendingSnapshot: string | null = null;

  begin(): void {
    if (this.pendingSnapshot === null) this.pendingSnapshot = serialize(state.project);
  }

  commit(): boolean {
    const pending = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (pending === null) return false;
    if (pending === serialize(state.project)) return false;
    this.undoSnapshots.push(pending);
    if (this.undoSnapshots.length > MAX_UNDO) {
      this.undoSnapshots.splice(0, this.undoSnapshots.length - MAX_UNDO);
    }
    this.redoSnapshots = [];
    syncHistoryState();
    return true;
  }

  cancel(): void {
    this.pendingSnapshot = null;
    syncHistoryState();
  }

  undo(): string | null {
    this.pendingSnapshot = null;
    const snapshot = this.undoSnapshots.pop();
    if (!snapshot) {
      syncHistoryState();
      return null;
    }
    this.redoSnapshots.push(serialize(state.project));
    if (this.redoSnapshots.length > MAX_UNDO) {
      this.redoSnapshots.splice(0, this.redoSnapshots.length - MAX_UNDO);
    }
    syncHistoryState();
    return snapshot;
  }

  redoStep(): string | null {
    this.pendingSnapshot = null;
    const snapshot = this.redoSnapshots.pop();
    if (!snapshot) {
      syncHistoryState();
      return null;
    }
    this.undoSnapshots.push(serialize(state.project));
    syncHistoryState();
    return snapshot;
  }

  reset(): void {
    this.undoSnapshots = [];
    this.redoSnapshots = [];
    this.pendingSnapshot = null;
    syncHistoryState();
  }

  get canUndo(): boolean {
    return this.undoSnapshots.length > 0 || this.pendingSnapshot !== null;
  }

  get canRedo(): boolean {
    return this.redoSnapshots.length > 0;
  }
}

const history = new HistoryController();

function syncHistoryState(): void {
  state.undoStack = new Array(history.canUndo ? 1 : 0).fill("");
  state.redoStack = new Array(history.canRedo ? 1 : 0).fill("");
}

let toastSeq = 1;

export function toast(text: string, kind: "info" | "success" | "error" = "info"): void {
  const id = toastSeq++;
  state.toasts = [...state.toasts.slice(-4), { id, text, kind }];
  store.emit("toasts");
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((entry) => entry.id !== id);
    store.emit("toasts");
  }, kind === "error" ? 7200 : 4200);
}

export function setBusy(label: string | null): void {
  state.busy = label;
  store.emit("ui");
}

function syncTitle(): void {
  const marker = state.dirty ? " *" : "";
  const title = `Studio Clone — ${state.project.name}${marker}`;
  document.title = title;
  api.setWindowTitle(title).catch(() => undefined);
}

function touch(emit: Emit, engine = true, title = true): void {
  state.dirty = true;
  state.project.modifiedAt = nowIso();
  state.revision += 1;
  if (title) syncTitle();
  store.emit(...(Array.isArray(emit) ? emit : [emit]));
  if (engine) scheduleEngineSync(160);
}

function edit<T>(emit: Emit, fn: () => T, engine = true): T {
  history.begin();
  const result = fn();
  if (history.commit()) touch(emit, engine);
  return result;
}

export function beginGesture(): void {
  history.begin();
}

export function cancelGesture(): void {
  history.cancel();
}

export function endGesture(emit: Emit = "project", engine = true): void {
  if (history.commit()) touch(emit, engine);
}

export function endEffectGesture(): void {
  endGesture("project");
}

// ---------------------------------------------------------------------------
// Audio engine synchronisation
// ---------------------------------------------------------------------------

let syncTimer: number | undefined;
let syncInFlight = false;
let syncQueued = false;

export function scheduleEngineSync(delay = 120): void {
  if (syncTimer !== undefined) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined;
    void syncEngine();
  }, delay);
}

export async function syncEngine(): Promise<void> {
  if (!state.ready) return;
  if (syncInFlight) {
    syncQueued = true;
    return;
  }
  syncInFlight = true;
  try {
    const snapshot = clone(state.project);
    const result = await api.setEngineProject(snapshot);
    state.engineWarnings = result.missingMedia;
    if (result.sampleRate > 0) {
      // The engine runs at the device rate; the project keeps its metadata rate.
    }
    const transport = await api.transportState();
    state.transport = transport;
    store.emit("engine", "transport");
  } catch (error) {
    state.engineWarnings = [String(error)];
    store.emit("engine");
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      void syncEngine();
    }
  }
}

// ---------------------------------------------------------------------------
// Transport polling
// ---------------------------------------------------------------------------

let pollTimer: number | undefined;
let pollBusy = false;

export function startTransportPolling(): void {
  if (pollTimer !== undefined) return;
  const tick = async (): Promise<void> => {
    if (!pollBusy) {
      pollBusy = true;
      try {
        const transport = await api.transportState();
        state.transport = transport;
        if (state.engineWarnings.length > 0 && transport.engineReady) {
          // engine warnings are refreshed by syncEngine; keep them until then
        }
        store.emit("transport");
      } catch (error) {
        if (state.ready) state.engineWarnings = [String(error)];
      } finally {
        pollBusy = false;
      }
    }
    const delay = state.transport?.playing ? 50 : 250;
    pollTimer = window.setTimeout(() => void tick(), delay);
  };
  pollTimer = window.setTimeout(() => void tick(), 250);
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

interface WaveformEntry {
  peaks: number[];
  durationSeconds: number;
}

const waveformCache = new Map<string, WaveformEntry>();
const waveformPending = new Map<string, Promise<void>>();

/**
 * Return the peaks that belong to this clip. `offsetTicks` and
 * `durationTicks` are essential after a split or a left-edge trim: without
 * them the second half of a clip would draw the beginning of the media again.
 */
export function waveformPeaks(
  path: string,
  offsetTicks = 0,
  durationTicks?: number,
): number[] | null {
  const entry = waveformCache.get(path);
  if (!entry) return null;
  const total = entry.peaks.length;
  if (total === 0 || entry.durationSeconds <= 0) return [];
  const secondsPerTick =
    60 / Math.max(1, state.project.tempo) / Math.max(1, state.project.ppq);
  const startSeconds = Math.max(0, offsetTicks) * secondsPerTick;
  if (startSeconds >= entry.durationSeconds) return [];
  const from = Math.min(
    total - 1,
    Math.max(0, Math.floor((startSeconds / entry.durationSeconds) * total)),
  );
  const count =
    durationTicks === undefined
      ? total - from
      : Math.max(
          1,
          Math.ceil(
            ((Math.max(1, durationTicks) * secondsPerTick) / entry.durationSeconds) *
              total,
          ),
        );
  return entry.peaks.slice(from, Math.min(total, from + count));
}

export async function ensureWaveform(path: string): Promise<void> {
  if (!path || waveformCache.has(path)) return;
  const pending = waveformPending.get(path);
  if (pending) return pending;
  const task = (async () => {
    try {
      const result = await api.getWaveform(path);
      waveformCache.set(path, {
        peaks: result.peaks,
        durationSeconds: result.durationSeconds,
      });
      store.emit("waveform");
    } catch {
      waveformCache.set(path, { peaks: [], durationSeconds: 0 });
    } finally {
      waveformPending.delete(path);
    }
  })();
  waveformPending.set(path, task);
  return task;
}

export function clearWaveformCache(): void {
  waveformCache.clear();
}

// ---------------------------------------------------------------------------
// Modals, layout, selection
// ---------------------------------------------------------------------------

export function openModal(type: ModalType, payload?: unknown): void {
  state.modal = { type, payload };
  store.emit("ui");
}

export function closeModal(): void {
  state.modal = null;
  state.exportProgress = null;
  store.emit("ui");
}

export function setLayout(patch: Partial<typeof state.layout>): void {
  Object.assign(state.layout, patch);
  store.emit("layout");
  try {
    localStorage.setItem("studio-clone.layout", JSON.stringify(state.layout));
  } catch {
    // Layout persistence is a convenience; ignore storage failures.
  }
}

export function restoreLayout(): void {
  try {
    const raw = localStorage.getItem("studio-clone.layout");
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<typeof state.layout>;
    if (Number.isFinite(Number(saved.leftWidth))) {
      state.layout.leftWidth = clamp(Number(saved.leftWidth), 228, 480);
    }
    if (Number.isFinite(Number(saved.bottomHeight))) {
      state.layout.bottomHeight = Math.max(MIN_BOTTOM_HEIGHT, Number(saved.bottomHeight));
    }
    if (saved.leftTab === "inspector" || saved.leftTab === "media") {
      state.layout.leftTab = saved.leftTab;
    }
    if (saved.bottomTab === "piano" || saved.bottomTab === "mixer" || saved.bottomTab === "none") {
      state.layout.bottomTab = saved.bottomTab;
    }
    if (Number.isFinite(Number(saved.arrangeZoom))) {
      state.layout.arrangeZoom = clamp(Math.round(Number(saved.arrangeZoom)), 18, 220);
    }
    if (Number.isFinite(Number(saved.pianoZoom))) {
      state.layout.pianoZoom = clamp(Math.round(Number(saved.pianoZoom)), 7, 24);
    }
    if (saved.tool === "select" || saved.tool === "draw" || saved.tool === "split") {
      state.layout.tool = saved.tool;
    }
    if (Number.isFinite(Number(saved.snapTicks))) {
      state.layout.snapTicks = Math.max(0, Math.round(Number(saved.snapTicks)));
    }
    if (typeof saved.trackColor === "string" && TRACK_COLORS.includes(saved.trackColor)) {
      state.layout.trackColor = saved.trackColor;
    }
    if (typeof saved.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.accentColor)) {
      state.layout.accentColor = saved.accentColor;
    }
    if (typeof saved.inputDevice === "string") {
      state.layout.inputDevice = saved.inputDevice;
    }
    if (typeof saved.showGrid === "boolean") {
      state.layout.showGrid = saved.showGrid;
    }
  } catch {
    // Ignore malformed layout state.
  }
}

export function setTool(tool: typeof state.layout.tool): void {
  setLayout({ tool });
}

export function setSnap(ticks: number): void {
  setLayout({ snapTicks: Math.max(0, Math.round(ticks)) });
}

export function setDefaultTrackColor(color: string): void {
  if (!TRACK_COLORS.includes(color)) return;
  setLayout({ trackColor: color });
}

export function setAccentColor(color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  setLayout({ accentColor: color });
}

export function setInputDevice(device: string): void {
  setLayout({ inputDevice: device });
}

export function setShowGrid(showGrid: boolean): void {
  setLayout({ showGrid });
}

export function resetLayout(): void {
  setLayout({
    leftWidth: 286,
    bottomHeight: DEFAULT_BOTTOM_HEIGHT,
    leftTab: "inspector",
    bottomTab: "piano",
    arrangeZoom: 64,
    pianoZoom: 12,
    tool: "select",
    snapTicks: 240,
    trackColor: TRACK_COLORS[0],
    accentColor: "#4f8fce",
    inputDevice: "",
    showGrid: true,
  });
}

export function setArrangeZoom(pxPerBeat: number): void {
  setLayout({ arrangeZoom: clamp(Math.round(pxPerBeat), 18, 220) });
}

export function setPianoZoom(pxPerKey: number): void {
  setLayout({ pianoZoom: clamp(Math.round(pxPerKey), 7, 24) });
}

export function setLeftTab(tab: "inspector" | "media"): void {
  setLayout({ leftTab: tab });
}

export function setBottomTab(tab: "piano" | "mixer" | "none"): void {
  setLayout({ bottomTab: tab });
}

export function selectTrack(trackId: string | null): void {
  const previous = state.selection.trackId;
  if (previous === trackId) {
    if (state.selection.clipId || state.selection.partId) {
      state.selection = { trackId, clipId: null, partId: null, noteIds: [] };
      store.emit("selection");
    }
    return;
  }
  state.selection = { trackId, clipId: null, partId: null, noteIds: [] };
  store.emit("selection");
}

export function selectClip(trackId: string, clipId: string): void {
  state.selection = { trackId, clipId, partId: null, noteIds: [] };
  store.emit("selection");
}

export function selectPart(trackId: string, partId: string, openPiano = false): void {
  state.selection = { trackId, clipId: null, partId, noteIds: [] };
  store.emit("selection");
  if (openPiano && state.layout.bottomTab !== "piano") setBottomTab("piano");
}

export function selectNotes(noteIds: string[]): void {
  state.selection = { ...state.selection, noteIds };
  store.emit("selection");
}

export function clearSelection(): void {
  state.selection = { trackId: null, clipId: null, partId: null, noteIds: [] };
  store.emit("selection");
}

export function selectedTrack(): Track | null {
  return state.project.tracks.find((track) => track.id === state.selection.trackId) ?? null;
}

export function findTrack(trackId: string): Track | null {
  return state.project.tracks.find((track) => track.id === trackId) ?? null;
}

export function findClip(trackId: string, clipId: string): AudioClip | null {
  return findTrack(trackId)?.clips.find((clip) => clip.id === clipId) ?? null;
}

export function findPart(trackId: string, partId: string): MidiPart | null {
  return findTrack(trackId)?.parts.find((part) => part.id === partId) ?? null;
}

function uniqueName(kind: TrackKind): string {
  const labels: Record<TrackKind, string> = {
    audio: "Audio",
    midi: "MIDI",
    instrument: "Instrument",
    group: "Group",
    fx: "FX",
    marker: "Marker",
    folder: "Folder",
  };
  const base = labels[kind];
  for (let index = 1; index < 10_000; index += 1) {
    const name = `${base} ${index}`;
    if (!state.project.tracks.some((track) => track.name === name)) return name;
  }
  return `${base} ${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export async function initApplication(): Promise<void> {
  try {
    restoreLayout();
    const [appInfo, devices, midiDevices, autosaves] = await Promise.all([
      api.appInfo(),
      api.getAudioDevices().catch((error) => ({
        outputs: [],
        inputs: [],
        currentOutput: null,
        error: String(error),
      })),
      api.getMidiDevices().catch((error) => ({ inputs: [], outputs: [], error: String(error) })),
      api.listAutosaveFiles().catch(() => []),
    ]);
    state.appInfo = appInfo;
    state.devices = devices;
    state.midiDevices = midiDevices;
    state.autosaves = autosaves;
    state.ready = true;
    state.bootError = null;
    syncHistoryState();
    syncTitle();
    store.emit("ui", "engine", "autosaves");
    await syncEngine();
    startTransportPolling();
    window.setInterval(() => {
      if (state.dirty && !state.busy) void autosave();
    }, 120_000);
    void onExportProgress((progress) => {
      state.exportProgress = progress;
      store.emit("ui");
    });
    if (autosaves.length > 0) openModal("recovery");
  } catch (error) {
    state.ready = false;
    state.bootError = String(error);
    store.emit("ui");
    throw error;
  }
}

function applyLoadedProject(
  project: Project,
  options: {
    path: string | null;
    dirty: boolean;
    missing?: MissingMedia[];
  },
): void {
  state.project = project;
  state.projectPath = options.path;
  state.dirty = options.dirty;
  state.selection = { trackId: null, clipId: null, partId: null, noteIds: [] };
  state.missingMedia = options.missing ?? [];
  state.engineWarnings = [];
  state.savedAt = options.dirty ? null : Date.now();
  state.revision += 1;
  history.reset();
  clearWaveformCache();
  syncTitle();
  store.emit("project", "selection", "ui");
  void syncEngine();
  for (const track of project.tracks) {
    for (const clip of track.clips) void ensureWaveform(clip.mediaPath);
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return fileDialog.confirm(
    `"${state.project.name}" contains unsaved changes. Continue and discard them?`,
    "Unsaved Changes",
  );
}

export async function newProject(): Promise<void> {
  if (recordingTrackId) await finishAudioRecording(false);
  if (!(await confirmDiscard())) return;
  try {
    await api.transportStop();
  } catch {
    // The engine may be unavailable; a new project is still valid.
  }
  applyLoadedProject(createProject(), { path: null, dirty: false });
  await syncEngine();
  toast("New project created.", "success");
}

export async function openProject(): Promise<void> {
  if (recordingTrackId) await finishAudioRecording(false);
  if (!(await confirmDiscard())) return;
  const path = await fileDialog.openProject();
  if (!path) return;
  await openProjectPath(path);
}

export async function openProjectPath(path: string): Promise<void> {
  if (recordingTrackId) await finishAudioRecording(false);
  setBusy("Opening project…");
  try {
    await api.transportStop().catch(() => undefined);
    const result = await api.openProjectFile(path);
    applyLoadedProject(result.project, {
      path: result.path,
      dirty: false,
      missing: result.missingMedia,
    });
    await syncEngine();
    if (result.missingMedia.length > 0) {
      toast(
        `${result.missingMedia.length} media file(s) are missing. Save the project to repair paths, or re-import the audio.`,
        "error",
      );
    } else {
      toast(`Opened "${result.project.name}".`, "success");
    }
    await refreshAutosaves();
  } catch (error) {
    toast(`Could not open project: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

export async function saveProject(saveAs = false): Promise<boolean> {
  let path = state.projectPath;
  if (!path || saveAs) {
    path = await fileDialog.saveProject(
      state.projectPath ??
        `${state.project.name.replace(/[\\/:*?"<>|]/g, "-")}.cproj`,
    );
    if (!path) return false;
  }
  setBusy("Saving project…");
  try {
    const result = await api.saveProjectFile(path, clone(state.project));
    state.project = result.project;
    state.projectPath = result.path;
    state.dirty = false;
    state.savedAt = Date.now();
    state.missingMedia = [];
    syncTitle();
    store.emit("project");
    await syncEngine();
    if (lastAutosavePath) {
      await api.deleteAutosaveFile(lastAutosavePath).catch(() => undefined);
      lastAutosavePath = null;
      await refreshAutosaves();
    }
    const copied = result.copiedFiles.length;
    toast(
      `Saved "${state.project.name}"${copied > 0 ? ` · ${copied} media file(s) consolidated` : ""}.`,
      "success",
    );
    return true;
  } catch (error) {
    toast(`Save failed: ${error}`, "error");
    return false;
  } finally {
    setBusy(null);
  }
}

let lastAutosavePath: string | null = null;

export async function autosave(): Promise<void> {
  if (!state.dirty || state.busy) return;
  try {
    const result = await api.autosaveProjectFile(clone(state.project));
    lastAutosavePath = result.path;
    state.lastAutosaveAt = Date.now();
    await refreshAutosaves();
    store.emit("ui");
  } catch (error) {
    console.warn("Autosave failed", error);
  }
}

export async function refreshAutosaves(): Promise<void> {
  try {
    state.autosaves = await api.listAutosaveFiles();
    store.emit("autosaves");
  } catch {
    // Listing is non-critical.
  }
}

export async function loadAutosave(path: string): Promise<void> {
  if (recordingTrackId) await finishAudioRecording(false);
  if (!(await confirmDiscard())) return;
  setBusy("Recovering autosave…");
  try {
    await api.transportStop().catch(() => undefined);
    const result = await api.loadAutosaveFile(path);
    applyLoadedProject(result.project, {
      path: null,
      dirty: true,
      missing: result.missingMedia,
    });
    closeModal();
    await syncEngine();
    await refreshAutosaves();
    toast("Autosave recovered. Save the project to keep it.", "success");
  } catch (error) {
    toast(`Recovery failed: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

export async function deleteAutosave(path: string): Promise<void> {
  try {
    await api.deleteAutosaveFile(path);
    await refreshAutosaves();
    toast("Autosave removed.", "success");
  } catch (error) {
    toast(`Could not remove autosave: ${error}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

export function setProjectName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed === state.project.name) return;
  edit("project", () => {
    state.project.name = trimmed;
  }, false);
  syncTitle();
}

export function setTempo(tempo: number): void {
  const value = clamp(tempo, 20, 300);
  if (Math.abs(value - state.project.tempo) < 0.0001) return;
  edit("project", () => {
    state.project.tempo = Math.round(value * 100) / 100;
  });
}

export function setTimeSignature(numerator: number, denominator: number): void {
  const num = clamp(Math.round(numerator), 1, 16);
  const den = [2, 4, 8, 16].includes(denominator) ? denominator : 4;
  edit("project", () => {
    state.project.timeSignature = { numerator: num, denominator: den };
  }, false);
}

export function setProjectSampleRate(sampleRate: number): void {
  edit("project", () => {
    state.project.sampleRate = clamp(Math.round(sampleRate), 8_000, 192_000);
  }, false);
}

export function setMetronome(enabled: boolean): void {
  edit("project", () => {
    state.project.metronome = enabled;
  });
}

export function setLoop(enabled: boolean, startTicks?: number, endTicks?: number): void {
  edit("project", () => {
    state.project.loopRegion.enabled = enabled;
    if (startTicks !== undefined) state.project.loopRegion.startTicks = Math.max(0, Math.round(startTicks));
    if (endTicks !== undefined) state.project.loopRegion.endTicks = Math.max(1, Math.round(endTicks));
    if (state.project.loopRegion.endTicks <= state.project.loopRegion.startTicks) {
      state.project.loopRegion.endTicks =
        state.project.loopRegion.startTicks + state.project.ppq;
    }
  }, false);
  api
    .transportSetLoop(
      enabled,
      state.project.loopRegion.startTicks,
      state.project.loopRegion.endTicks,
    )
    .catch(() => undefined);
  scheduleEngineSync(120);
}

export function addMarker(ticks?: number, name?: string): void {
  const position = ticks ?? state.transport?.positionTicks ?? 0;
  edit("project", () => {
    state.project.markers.push({
      id: uuid(),
      name: name ?? `Marker ${state.project.markers.length + 1}`,
      ticks: Math.max(0, Math.round(position)),
      color: "#c9a227",
    });
    state.project.markers.sort((a, b) => a.ticks - b.ticks);
  }, false);
}

export function renameMarker(id: string, name: string): void {
  edit("project", () => {
    const marker = state.project.markers.find((entry) => entry.id === id);
    if (marker) marker.name = name;
  }, false);
}

export function removeMarker(id: string): void {
  edit("project", () => {
    state.project.markers = state.project.markers.filter((entry) => entry.id !== id);
  }, false);
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export function addTrack(kind: TrackKind, name?: string, color?: string): Track | null {
  if (kind === "marker" || kind === "folder") return null;
  let createdId: string | null = null;
  edit("project", () => {
    const chosenColor =
      color ??
      (TRACK_COLORS.includes(state.layout.trackColor)
        ? state.layout.trackColor
        : TRACK_COLORS[state.project.tracks.length % TRACK_COLORS.length]);
    const track = createTrack(kind, name?.trim() || uniqueName(kind), chosenColor);
    if (kind === "midi") track.instrument = defaultInstrument();
    if (kind === "group" || kind === "fx") {
      track.volumeDb = 0;
      track.input = "";
    }
    state.project.tracks.push(track);
    createdId = track.id;
    state.selection = { trackId: track.id, clipId: null, partId: null, noteIds: [] };
    store.emit("selection");
  });
  const created = createdId ? findTrack(createdId) : null;
  if (created) toast(`${created.name} added.`, "success");
  return created;
}

export function deleteTrack(trackId: string): void {
  edit("project", () => {
    state.project.tracks = state.project.tracks.filter((track) => track.id !== trackId);
    for (const track of state.project.tracks) {
      if (track.output === trackId) track.output = "master";
      track.sends = track.sends.filter((send) => send.targetTrackId !== trackId);
    }
    if (state.selection.trackId === trackId) {
      state.selection = { trackId: null, clipId: null, partId: null, noteIds: [] };
      store.emit("selection");
    }
  });
}

export function duplicateTrack(trackId: string): void {
  const source = findTrack(trackId);
  if (!source) return;
  let createdId: string | null = null;
  edit("project", () => {
    const copy = clone(source);
    copy.id = uuid();
    copy.name = `${source.name} copy`;
    copy.clips = source.clips.map((clip) => ({ ...clone(clip), id: uuid() }));
    copy.parts = source.parts.map((part) => ({
      ...clone(part),
      id: uuid(),
      notes: part.notes.map((note) => ({ ...clone(note), id: uuid() })),
    }));
    copy.inserts = source.inserts.map((insert) => ({ ...clone(insert), id: uuid() }));
    copy.sends = source.sends.map((send) => ({ ...clone(send), id: uuid() }));
    const index = state.project.tracks.findIndex((track) => track.id === trackId);
    state.project.tracks.splice(index + 1, 0, copy);
    state.selection = { trackId: copy.id, clipId: null, partId: null, noteIds: [] };
    store.emit("selection");
    createdId = copy.id;
  });
  const created = createdId ? findTrack(createdId) : null;
  if (created) toast(`${created.name} created.`, "success");
}

export function updateTrack(
  trackId: string,
  patch: Partial<Track>,
  options: { transient?: boolean; emit?: Emit; engine?: boolean } = {},
): void {
  const track = findTrack(trackId);
  if (!track) return;
  const apply = (): void => {
    Object.assign(track, patch);
  };
  if (options.transient) {
    apply();
    touch(options.emit ?? "track", options.engine ?? true, false);
  } else {
    edit(options.emit ?? "project", apply, options.engine ?? true);
  }
}

export function setTrackVolume(trackId: string, db: number, transient = false): void {
  updateTrack(trackId, { volumeDb: clamp(db, -96, 12) }, { transient, emit: transient ? "track" : "project" });
}

export function setTrackPan(trackId: string, pan: number, transient = false): void {
  updateTrack(trackId, { pan: clamp(pan, -1, 1) }, { transient, emit: transient ? "track" : "project" });
}

export function toggleMute(trackId: string): void {
  const track = findTrack(trackId);
  if (!track) return;
  updateTrack(trackId, { mute: !track.mute });
}

export function toggleSolo(trackId: string): void {
  const track = findTrack(trackId);
  if (!track) return;
  updateTrack(trackId, { solo: !track.solo });
}

function setRecordArm(trackId: string, armed: boolean): void {
  const track = findTrack(trackId);
  if (!track) return;
  if (track.kind !== "audio") {
    toast("Recording currently targets audio tracks only.", "info");
    return;
  }
  edit("project", () => {
    for (const entry of state.project.tracks) {
      if (entry.kind === "audio") entry.recordArm = entry.id === trackId && armed;
    }
  });
}

export function toggleRecordArm(trackId: string): void {
  const track = findTrack(trackId);
  if (!track) return;
  setRecordArm(trackId, !track.recordArm);
}

export function setTrackHeight(trackId: string, height: number, transient = false): void {
  updateTrack(
    trackId,
    { height: clamp(Math.round(height), 38, 220) },
    { transient, emit: transient ? "track" : "project", engine: false },
  );
}

export function setTrackColor(trackId: string, color: string): void {
  updateTrack(trackId, { color });
}

export function renameTrack(trackId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateTrack(trackId, { name: trimmed }, { engine: false });
}

export function setTrackOutput(trackId: string, output: string): void {
  updateTrack(trackId, { output });
}

export function setTrackInput(trackId: string, input: string): void {
  updateTrack(trackId, { input });
}

export function setInstrument(
  trackId: string,
  patch: Partial<InstrumentSettings>,
  transient = false,
): void {
  const track = findTrack(trackId);
  if (!track?.instrument) return;
  const next = { ...track.instrument, ...patch };
  updateTrack(trackId, { instrument: next }, { transient, emit: transient ? "track" : "project" });
}

export interface InstrumentPreset {
  name: string;
  settings: Partial<InstrumentSettings>;
}

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  {
    name: "Init Saw",
    settings: {
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
    },
  },
  {
    name: "Warm Pad",
    settings: {
      wave1: "saw",
      wave2: "triangle",
      detuneCents: 14,
      oscMix: 0.6,
      attack: 0.8,
      decay: 1.2,
      sustain: 0.8,
      release: 1.8,
      cutoffHz: 1600,
      resonance: 0.12,
      lfoRateHz: 0.25,
      lfoDepth: 0.35,
      lfoTarget: "filter",
      gainDb: -10,
    },
  },
  {
    name: "Sync Pluck",
    settings: {
      wave1: "square",
      wave2: "saw",
      detuneCents: 0,
      oscMix: 0.5,
      attack: 0.002,
      decay: 0.16,
      sustain: 0.05,
      release: 0.2,
      cutoffHz: 5200,
      resonance: 0.45,
      lfoRateHz: 5,
      lfoDepth: 0,
      lfoTarget: "pitch",
      gainDb: -9,
    },
  },
  {
    name: "Sub Bass",
    settings: {
      wave1: "sine",
      wave2: "triangle",
      detuneCents: 0,
      oscMix: 0.3,
      attack: 0.006,
      decay: 0.3,
      sustain: 0.7,
      release: 0.16,
      cutoffHz: 700,
      resonance: 0.1,
      lfoRateHz: 0,
      lfoDepth: 0,
      lfoTarget: "filter",
      gainDb: -6,
    },
  },
  {
    name: "Glass Lead",
    settings: {
      wave1: "triangle",
      wave2: "sine",
      detuneCents: 5,
      oscMix: 0.55,
      attack: 0.01,
      decay: 0.3,
      sustain: 0.55,
      release: 0.4,
      cutoffHz: 8200,
      resonance: 0.25,
      lfoRateHz: 5.5,
      lfoDepth: 0.12,
      lfoTarget: "pitch",
      gainDb: -10,
    },
  },
  {
    name: "Noise Sweep",
    settings: {
      wave1: "noise",
      wave2: "saw",
      detuneCents: 3,
      oscMix: 0.25,
      attack: 0.4,
      decay: 1,
      sustain: 0.6,
      release: 1.2,
      cutoffHz: 2400,
      resonance: 0.3,
      lfoRateHz: 0.3,
      lfoDepth: 0.5,
      lfoTarget: "filter",
      gainDb: -12,
    },
  },
];

export function applyInstrumentPreset(trackId: string, presetName: string): void {
  const preset = INSTRUMENT_PRESETS.find((entry) => entry.name === presetName);
  const track = findTrack(trackId);
  if (!preset || !track?.instrument) return;
  edit("project", () => {
    track.instrument = { ...track.instrument, ...preset.settings, preset: preset.name } as InstrumentSettings;
  });
}

// ---------------------------------------------------------------------------
// Audio clips
// ---------------------------------------------------------------------------

function secondsToTicks(seconds: number): number {
  return Math.max(
    1,
    Math.round((seconds * state.project.tempo * state.project.ppq) / 60),
  );
}

export function ensureAudioTrack(): Track {
  const selected = selectedTrack();
  if (selected?.kind === "audio") return selected;
  const created = addTrack("audio");
  return created ?? state.project.tracks.find((track) => track.kind === "audio")!;
}

export function addAudioClip(
  trackId: string,
  importResult: AudioImportResult,
  startTicks: number,
): AudioClip | null {
  const track = findTrack(trackId);
  if (!track) return null;
  const clip: AudioClip = {
    id: uuid(),
    name: importResult.name,
    mediaPath: importResult.path,
    startTicks: Math.max(0, Math.round(startTicks)),
    offsetTicks: 0,
    durationTicks: secondsToTicks(importResult.durationSeconds),
    gainDb: 0,
    fadeInTicks: 0,
    fadeOutTicks: 0,
    color: track.color,
    mediaSampleRate: importResult.sampleRate,
  };
  edit("project", () => {
    track.clips.push(clip);
    state.selection = { trackId, clipId: clip.id, partId: null, noteIds: [] };
    store.emit("selection");
  });
  void ensureWaveform(clip.mediaPath);
  return clip;
}

export async function importAudioFile(
  path?: string,
  options: { trackId?: string; startTicks?: number; usePlayhead?: boolean } = {},
): Promise<void> {
  const chosen = path ?? (await fileDialog.importAudio());
  if (!chosen) return;
  setBusy("Importing audio…");
  try {
    const result = await api.importAudio(chosen);
    let target = options.trackId ? findTrack(options.trackId) : selectedTrack();
    if (!target || target.kind !== "audio") target = ensureAudioTrack();
    const start =
      options.startTicks ??
      (options.usePlayhead === false ? 0 : state.transport?.positionTicks ?? 0);
    const clip = addAudioClip(target.id, result, start);
    await syncEngine();
    toast(
      `Imported "${result.name}" · ${result.durationSeconds.toFixed(2)}s · ${result.sampleRate} Hz`,
      "success",
    );
    if (clip) void ensureWaveform(clip.mediaPath);
  } catch (error) {
    toast(`Audio import failed: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

export function updateClip(
  trackId: string,
  clipId: string,
  patch: Partial<AudioClip>,
  transient = false,
): void {
  const clip = findClip(trackId, clipId);
  if (!clip) return;
  if (transient) {
    Object.assign(clip, patch);
    touch("track", true, false);
  } else {
    edit("project", () => Object.assign(clip, patch));
  }
}

export function deleteClip(trackId: string, clipId: string): void {
  edit("project", () => {
    const track = findTrack(trackId);
    if (!track) return;
    track.clips = track.clips.filter((clip) => clip.id !== clipId);
    if (state.selection.clipId === clipId) {
      state.selection = { ...state.selection, clipId: null };
      store.emit("selection");
    }
  });
}

export function splitClip(trackId: string, clipId: string, atTicks: number): void {
  const clip = findClip(trackId, clipId);
  if (!clip) return;
  const split = Math.round(atTicks);
  const start = clip.startTicks;
  const end = clip.startTicks + clip.durationTicks;
  if (split <= start || split >= end) return;
  edit("project", () => {
    const track = findTrack(trackId);
    if (!track) return;
    const right: AudioClip = {
      ...clone(clip),
      id: uuid(),
      startTicks: split,
      offsetTicks: clip.offsetTicks + (split - start),
      durationTicks: end - split,
      fadeInTicks: 0,
      fadeOutTicks: clip.fadeOutTicks,
    };
    clip.durationTicks = split - start;
    clip.fadeOutTicks = 0;
    track.clips.push(right);
    state.selection = { trackId, clipId: right.id, partId: null, noteIds: [] };
    store.emit("selection");
  });
}

export function duplicateClip(trackId: string, clipId: string): void {
  const clip = findClip(trackId, clipId);
  const track = findTrack(trackId);
  if (!clip || !track) return;
  edit("project", () => {
    const copy: AudioClip = {
      ...clone(clip),
      id: uuid(),
      startTicks: clip.startTicks + clip.durationTicks,
    };
    track.clips.push(copy);
    state.selection = { trackId, clipId: copy.id, partId: null, noteIds: [] };
    store.emit("selection");
  });
}

// ---------------------------------------------------------------------------
// MIDI parts and notes
// ---------------------------------------------------------------------------

export function addMidiPart(trackId: string, startTicks: number, durationTicks?: number): MidiPart | null {
  const track = findTrack(trackId);
  if (!track || (track.kind !== "instrument" && track.kind !== "midi")) return null;
  if (!track.instrument) track.instrument = defaultInstrument();
  const part: MidiPart = {
    id: uuid(),
    name: `${track.name} Part ${track.parts.length + 1}`,
    startTicks: Math.max(0, Math.round(startTicks)),
    durationTicks: Math.max(state.project.ppq, Math.round(durationTicks ?? state.project.ppq * 4)),
    color: track.color,
    notes: [],
  };
  edit("project", () => {
    track.parts.push(part);
    state.selection = { trackId, clipId: null, partId: part.id, noteIds: [] };
    store.emit("selection");
  });
  return part;
}

export function updatePart(
  trackId: string,
  partId: string,
  patch: Partial<MidiPart>,
  transient = false,
): void {
  const part = findPart(trackId, partId);
  if (!part) return;
  if (transient) {
    Object.assign(part, patch);
    touch("track", false, false);
  } else {
    edit("project", () => Object.assign(part, patch), false);
  }
}

export function deletePart(trackId: string, partId: string): void {
  edit("project", () => {
    const track = findTrack(trackId);
    if (!track) return;
    track.parts = track.parts.filter((part) => part.id !== partId);
    if (state.selection.partId === partId) {
      state.selection = { ...state.selection, partId: null, noteIds: [] };
      store.emit("selection");
    }
  });
}

export function splitPart(trackId: string, partId: string, atTicks: number): void {
  const part = findPart(trackId, partId);
  const track = findTrack(trackId);
  if (!part || !track) return;
  const split = Math.round(atTicks);
  const start = part.startTicks;
  const end = part.startTicks + part.durationTicks;
  if (split <= start || split >= end) return;
  edit("project", () => {
    const left: MidiPart = {
      ...clone(part),
      id: uuid(),
      durationTicks: split - start,
      notes: [],
    };
    const right: MidiPart = {
      ...clone(part),
      id: uuid(),
      name: `${part.name} B`,
      startTicks: split,
      durationTicks: end - split,
      notes: [],
    };
    for (const note of part.notes) {
      const noteStart = part.startTicks + note.startTicks;
      const noteEnd = noteStart + note.durationTicks;
      if (noteStart < split) {
        const clippedEnd = Math.min(noteEnd, split);
        left.notes.push({
          ...clone(note),
          id: uuid(),
          startTicks: noteStart - start,
          durationTicks: Math.max(1, clippedEnd - noteStart),
        });
      }
      if (noteEnd > split) {
        const clippedStart = Math.max(noteStart, split);
        right.notes.push({
          ...clone(note),
          id: uuid(),
          startTicks: clippedStart - split,
          durationTicks: Math.max(1, noteEnd - clippedStart),
        });
      }
    }
    part.name = `${part.name} A`;
    part.durationTicks = split - start;
    part.notes = left.notes;
    right.notes = right.notes;
    track.parts.push(right);
    state.selection = { trackId, clipId: null, partId: right.id, noteIds: [] };
    store.emit("selection");
  });
}

export function duplicatePart(trackId: string, partId: string): void {
  const part = findPart(trackId, partId);
  const track = findTrack(trackId);
  if (!part || !track) return;
  edit("project", () => {
    const copy: MidiPart = {
      ...clone(part),
      id: uuid(),
      name: `${part.name} copy`,
      startTicks: part.startTicks + part.durationTicks,
      notes: part.notes.map((note) => ({ ...clone(note), id: uuid() })),
    };
    track.parts.push(copy);
    state.selection = { trackId, clipId: null, partId: copy.id, noteIds: [] };
    store.emit("selection");
  });
}

export function addNote(
  trackId: string,
  partId: string,
  note: Omit<MidiNote, "id">,
): MidiNote | null {
  const part = findPart(trackId, partId);
  if (!part) return null;
  const created: MidiNote = { ...note, id: uuid(), channel: note.channel ?? 0 };
  edit("project", () => {
    part.notes.push(created);
    part.notes.sort((a, b) => a.startTicks - b.startTicks || a.pitch - b.pitch);
    part.durationTicks = Math.max(
      part.durationTicks,
      created.startTicks + created.durationTicks,
    );
    state.selection = { ...state.selection, noteIds: [created.id] };
    store.emit("selection");
  }, true);
  return created;
}

export function updateNote(
  trackId: string,
  partId: string,
  noteId: string,
  patch: Partial<MidiNote>,
  transient = false,
): void {
  const note = findPart(trackId, partId)?.notes.find((entry) => entry.id === noteId);
  if (!note) return;
  if (transient) {
    Object.assign(note, patch);
    touch("track", true, false);
  } else {
    edit("project", () => Object.assign(note, patch), true);
  }
}

export function deleteNotes(trackId: string, partId: string, noteIds: string[]): void {
  if (noteIds.length === 0) return;
  edit("project", () => {
    const part = findPart(trackId, partId);
    if (!part) return;
    part.notes = part.notes.filter((note) => !noteIds.includes(note.id));
    state.selection = { ...state.selection, noteIds: [] };
    store.emit("selection");
  }, true);
}

export function quantizeNotes(
  trackId: string,
  partId: string,
  gridTicks = state.layout.snapTicks,
  selectedOnly = true,
): void {
  const part = findPart(trackId, partId);
  if (!part) return;
  const ids = state.selection.noteIds;
  const targets =
    selectedOnly && ids.length > 0
      ? part.notes.filter((note) => ids.includes(note.id))
      : part.notes;
  if (targets.length === 0) return;
  edit("project", () => {
    for (const note of targets) {
      note.startTicks = Math.max(0, Math.round(note.startTicks / gridTicks) * gridTicks);
    }
    part.notes.sort((a, b) => a.startTicks - b.startTicks || a.pitch - b.pitch);
  }, true);
  toast(`Quantized ${targets.length} note(s) to 1/${gridDivisor(gridTicks)}.`, "success");
}

export function gridDivisor(gridTicks: number): string {
  const beat = state.project.ppq;
  const ratio = beat / Math.max(1, gridTicks);
  if (Math.abs(ratio - Math.round(ratio)) < 0.001) return String(Math.round(ratio));
  return ratio.toFixed(2);
}

export function transposeNotes(trackId: string, partId: string, semitones: number): void {
  const part = findPart(trackId, partId);
  if (!part) return;
  const ids = state.selection.noteIds;
  const targets = ids.length > 0 ? part.notes.filter((note) => ids.includes(note.id)) : part.notes;
  if (targets.length === 0) return;
  edit("project", () => {
    for (const note of targets) note.pitch = clamp(note.pitch + semitones, 0, 127);
  }, true);
}

export function setNoteVelocity(
  trackId: string,
  partId: string,
  noteIds: string[],
  velocity: number,
  transient = false,
): void {
  const part = findPart(trackId, partId);
  if (!part) return;
  const value = clamp(Math.round(velocity), 1, 127);
  if (transient) {
    for (const note of part.notes) if (noteIds.includes(note.id)) note.velocity = value;
    touch("track", false, false);
  } else {
    edit("project", () => {
      for (const note of part.notes) if (noteIds.includes(note.id)) note.velocity = value;
    }, false);
  }
}

// ---------------------------------------------------------------------------
// Inserts and master bus
// ---------------------------------------------------------------------------

export type EffectHost = string | "master";

function effectContainer(host: EffectHost): { inserts: InsertEffect[] } | null {
  if (host === "master") return state.project.master;
  return findTrack(host);
}

export function addInsert(host: EffectHost, kind: EffectKind): InsertEffect | null {
  const container = effectContainer(host);
  if (!container) return null;
  const insert = createInsert(kind, uuid());
  edit("project", () => container.inserts.push(insert));
  return insert;
}

export function removeInsert(host: EffectHost, effectId: string): void {
  const container = effectContainer(host);
  if (!container) return;
  edit("project", () => {
    container.inserts = container.inserts.filter((insert) => insert.id !== effectId);
  });
}

export function toggleInsert(host: EffectHost, effectId: string): void {
  const container = effectContainer(host);
  const insert = container?.inserts.find((entry) => entry.id === effectId);
  if (!container || !insert) return;
  edit("project", () => {
    insert.enabled = !insert.enabled;
  });
}

export function moveInsert(host: EffectHost, effectId: string, direction: -1 | 1): void {
  const container = effectContainer(host);
  if (!container) return;
  const index = container.inserts.findIndex((insert) => insert.id === effectId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= container.inserts.length) return;
  edit("project", () => {
    const [insert] = container.inserts.splice(index, 1);
    container.inserts.splice(next, 0, insert);
  });
}

export function setInsertParam(
  host: EffectHost,
  effectId: string,
  key: string,
  value: number,
  transient = false,
): void {
  const insert = effectContainer(host)?.inserts.find((entry) => entry.id === effectId);
  if (!insert) return;
  if (transient) {
    insert.params[key] = value;
    touch("track", true, false);
  } else {
    edit("project", () => {
      insert.params[key] = value;
    });
  }
}

export function findInsert(host: EffectHost, effectId: string): InsertEffect | null {
  return effectContainer(host)?.inserts.find((entry) => entry.id === effectId) ?? null;
}

export function setMasterVolume(db: number, transient = false): void {
  if (transient) {
    state.project.master.volumeDb = clamp(db, -96, 12);
    touch("track", true, false);
  } else {
    edit("project", () => {
      state.project.master.volumeDb = clamp(db, -96, 12);
    });
  }
}

export function setMasterPan(pan: number, transient = false): void {
  if (transient) {
    state.project.master.pan = clamp(pan, -1, 1);
    touch("track", true, false);
  } else {
    edit("project", () => {
      state.project.master.pan = clamp(pan, -1, 1);
    });
  }
}

export function setMasterLimiter(enabled: boolean): void {
  edit("project", () => {
    state.project.master.limiter = enabled;
  });
}

// ---------------------------------------------------------------------------
// Selection editing
// ---------------------------------------------------------------------------

export function deleteSelection(): void {
  const { trackId, clipId, partId, noteIds } = state.selection;
  if (!trackId) return;
  if (partId && noteIds.length > 0) {
    deleteNotes(trackId, partId, noteIds);
    return;
  }
  if (clipId) {
    deleteClip(trackId, clipId);
    return;
  }
  if (partId) deletePart(trackId, partId);
}

export function duplicateSelection(): void {
  const { trackId, clipId, partId, noteIds } = state.selection;
  if (!trackId) return;
  if (partId && noteIds.length > 0) {
    const part = findPart(trackId, partId);
    if (!part) return;
    const selected = part.notes.filter((note) => noteIds.includes(note.id));
    if (selected.length === 0) return;
    const minStart = Math.min(...selected.map((note) => note.startTicks));
    const maxEnd = Math.max(...selected.map((note) => note.startTicks + note.durationTicks));
    const offset = maxEnd - minStart;
    edit("project", () => {
      const copies = selected.map((note) => ({
        ...clone(note),
        id: uuid(),
        startTicks: note.startTicks + offset,
      }));
      part.notes.push(...copies);
      part.notes.sort((a, b) => a.startTicks - b.startTicks || a.pitch - b.pitch);
      state.selection = { ...state.selection, noteIds: copies.map((note) => note.id) };
      store.emit("selection");
    }, true);
    return;
  }
  if (clipId) {
    duplicateClip(trackId, clipId);
    return;
  }
  if (partId) duplicatePart(trackId, partId);
}

export function splitAtPlayhead(): void {
  const { trackId, clipId, partId } = state.selection;
  const tick = state.transport?.positionTicks ?? 0;
  if (!trackId) return;
  if (clipId) splitClip(trackId, clipId, tick);
  else if (partId) splitPart(trackId, partId, tick);
}

export function selectAllNotes(): void {
  const part = selectedPartSafe();
  if (!part) return;
  state.selection = {
    ...state.selection,
    noteIds: part.notes.map((note) => note.id),
  };
  store.emit("selection");
}

function selectedPartSafe(): MidiPart | null {
  const { trackId, partId } = state.selection;
  if (!trackId || !partId) return null;
  return findPart(trackId, partId);
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export function undo(): void {
  const snapshot = history.undo();
  if (!snapshot) {
    toast("Nothing to undo.", "info");
    return;
  }
  try {
    state.project = JSON.parse(snapshot) as Project;
    state.dirty = true;
    state.revision += 1;
    validateSelection();
    syncTitle();
    store.emit("project", "selection");
    void syncEngine();
  } catch {
    toast("Could not restore the previous state.", "error");
  }
}

export function redo(): void {
  const snapshot = history.redoStep();
  if (!snapshot) {
    toast("Nothing to redo.", "info");
    return;
  }
  try {
    state.project = JSON.parse(snapshot) as Project;
    state.dirty = true;
    state.revision += 1;
    validateSelection();
    syncTitle();
    store.emit("project", "selection");
    void syncEngine();
  } catch {
    toast("Could not redo the last change.", "error");
  }
}

function validateSelection(): void {
  const track = findTrack(state.selection.trackId ?? "");
  if (!track) {
    state.selection = { trackId: null, clipId: null, partId: null, noteIds: [] };
    return;
  }
  if (state.selection.clipId && !track.clips.some((clip) => clip.id === state.selection.clipId)) {
    state.selection.clipId = null;
  }
  if (state.selection.partId && !track.parts.some((part) => part.id === state.selection.partId)) {
    state.selection.partId = null;
    state.selection.noteIds = [];
  }
}

// ---------------------------------------------------------------------------
// Transport and audio recording
// ---------------------------------------------------------------------------

let recordingTrackId: string | null = null;
let recordingStartTicks = 0;
let recordingBusy = false;

export function isAudioRecording(): boolean {
  return recordingTrackId !== null;
}

function chooseRecordingTrack(): Track | null {
  const armed = state.project.tracks.find(
    (track) => track.kind === "audio" && track.recordArm,
  );
  if (armed) return armed;
  const selected = selectedTrack();
  if (selected?.kind === "audio") {
    setRecordArm(selected.id, true);
    return selected;
  }
  const existing = state.project.tracks.find((track) => track.kind === "audio");
  if (existing) {
    setRecordArm(existing.id, true);
    toast(`Recording armed on ${existing.name}.`, "info");
    return existing;
  }
  const created = addTrack("audio", "Recording");
  if (created) setRecordArm(created.id, true);
  return created;
}

function recordingInput(track: Track): string | null {
  const inputs = state.devices?.inputs ?? [];
  const preferred = state.layout.inputDevice.trim();
  if (preferred && inputs.includes(preferred)) return preferred;
  if (track.input && inputs.includes(track.input)) return track.input;
  return inputs[0] ?? null;
}

async function finishAudioRecording(returnToStart: boolean): Promise<void> {
  if (!recordingTrackId || recordingBusy) return;
  const trackId = recordingTrackId;
  const startTicks = recordingStartTicks;
  recordingTrackId = null;
  recordingBusy = true;
  try {
    const result = await api.stopAudioRecording();
    if (returnToStart) await api.transportReturnToStart();
    state.transport = await api.transportState();
    store.emit("transport");

    const imported = await api.importAudio(result.path);
    imported.name = `Recording ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;
    const clip = addAudioClip(trackId, imported, startTicks);
    await syncEngine();
    if (clip) void ensureWaveform(clip.mediaPath);

    if (result.inputError) {
      toast(`Recording finished with an input error: ${result.inputError}`, "error");
    } else if (result.droppedFrames > 0) {
      toast(
        `Recording saved, but ${result.droppedFrames} frame(s) were dropped because the disk fell behind.`,
        "error",
      );
    } else {
      toast(
        `Recorded ${result.durationSeconds.toFixed(2)}s to ${
          findTrack(trackId)?.name ?? "the audio track"
        }.`,
        "success",
      );
    }
  } catch (error) {
    toast(`Could not finish recording: ${error}`, "error");
  } finally {
    recordingBusy = false;
    store.emit("transport");
  }
}

export async function toggleAudioRecording(): Promise<void> {
  if (recordingBusy) return;
  if (recordingTrackId) {
    await finishAudioRecording(false);
    return;
  }

  recordingBusy = true;
  let started = false;
  try {
    const target = chooseRecordingTrack();
    if (!target) {
      toast("Add an audio track before recording.", "info");
      return;
    }
    let input = recordingInput(target);
    if (!input) {
      await refreshDevices();
      input = recordingInput(target);
    }
    if (!input) {
      toast("No audio input was detected. Choose an input in Settings.", "error");
      return;
    }
    const startTicks = state.transport?.positionTicks ?? 0;
    await api.startAudioRecording(input, startTicks);
    started = true;
    recordingTrackId = target.id;
    recordingStartTicks = startTicks;
    state.transport = await api.transportState();
    store.emit("transport");
    toast(`Recording to ${target.name} via ${input}.`, "info");
  } catch (error) {
    if (started) {
      await api.stopAudioRecording().catch(() => undefined);
    }
    recordingTrackId = null;
    toast(`Could not start recording: ${error}`, "error");
  } finally {
    recordingBusy = false;
    store.emit("transport");
  }
}

export async function transportToggle(): Promise<void> {
  if (recordingTrackId) {
    await finishAudioRecording(false);
    return;
  }
  try {
    if (state.transport?.playing) await api.transportPause();
    else await api.transportPlay();
    state.transport = await api.transportState();
    store.emit("transport");
  } catch (error) {
    toast(`Transport unavailable: ${error}`, "error");
  }
}

export async function transportPlay(): Promise<void> {
  if (recordingTrackId) return;
  try {
    await api.transportPlay();
    state.transport = await api.transportState();
    store.emit("transport");
  } catch (error) {
    toast(`Playback failed: ${error}`, "error");
  }
}

export async function transportStop(): Promise<void> {
  if (recordingTrackId) {
    await finishAudioRecording(true);
    return;
  }
  try {
    await api.transportStop();
    await api.transportReturnToStart();
    state.transport = await api.transportState();
    store.emit("transport");
  } catch (error) {
    toast(`Transport unavailable: ${error}`, "error");
  }
}

export async function transportPause(): Promise<void> {
  if (recordingTrackId) {
    await finishAudioRecording(false);
    return;
  }
  try {
    await api.transportPause();
    state.transport = await api.transportState();
    store.emit("transport");
  } catch (error) {
    toast(`Transport unavailable: ${error}`, "error");
  }
}

export async function seekTicks(ticks: number): Promise<void> {
  if (recordingTrackId) {
    toast("Stop recording before moving the playhead.", "info");
    return;
  }
  try {
    await api.transportSeek(Math.max(0, Math.round(ticks)));
    state.transport = await api.transportState();
    store.emit("transport");
  } catch (error) {
    toast(`Cannot seek: ${error}`, "error");
  }
}

export async function returnToStart(): Promise<void> {
  if (recordingTrackId) {
    toast("Stop recording before moving the playhead.", "info");
    return;
  }
  try {
    await api.transportReturnToStart();
    state.transport = await api.transportState();
    store.emit("transport");
  } catch {
    // Ignore when no engine is available.
  }
}

export async function toggleLoop(): Promise<void> {
  setLoop(!state.project.loopRegion.enabled);
}

export async function toggleMetronome(): Promise<void> {
  setMetronome(!state.project.metronome);
}

export async function audition(trackId: string, pitch: number, velocity = 100): Promise<void> {
  if (!trackId) return;
  try {
    await api.auditionNote(trackId, Math.round(pitch), Math.round(velocity), true);
    window.setTimeout(() => {
      api.auditionNote(trackId, Math.round(pitch), Math.round(velocity), false).catch(() => undefined);
    }, 260);
  } catch {
    // Audition is unavailable when the audio engine failed to start.
  }
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export async function importMidiFile(path?: string): Promise<void> {
  const chosen = path ?? (await fileDialog.importMidi());
  if (!chosen) return;
  setBusy("Importing MIDI…");
  try {
    const result: MidiImportResult = await api.importMidi(chosen, state.project.ppq);
    if (result.parts.length === 0) {
      toast("The MIDI file contains no notes.", "error");
      return;
    }
    const createdTracks: Track[] = [];
    edit("project", () => {
      if (result.tempo && result.tempo > 20 && result.tempo < 300) {
        state.project.tempo = Math.round(result.tempo * 100) / 100;
      }
      result.parts.forEach((part, index) => {
        const color = TRACK_COLORS[(state.project.tracks.length + index) % TRACK_COLORS.length];
        const track = createTrack("instrument", uniqueImportedName(part.name), color);
        track.instrument = defaultInstrument();
        track.parts.push({
          ...clone(part),
          id: uuid(),
          startTicks: 0,
          color,
          notes: part.notes.map((note) => ({ ...clone(note), id: uuid() })),
        });
        state.project.tracks.push(track);
        createdTracks.push(track);
      });
      const firstTrack = createdTracks[0];
      state.selection = firstTrack
        ? { trackId: firstTrack.id, clipId: null, partId: firstTrack.parts[0].id, noteIds: [] }
        : state.selection;
      store.emit("selection");
      if (firstTrack) setBottomTab("piano");
    });
    await syncEngine();
    const notes = result.parts.reduce((total, part) => total + part.notes.length, 0);
    toast(
      `Imported ${result.parts.length} MIDI track(s), ${notes} note(s)${
        result.tempo ? ` · tempo ${result.tempo.toFixed(1)} BPM` : ""
      }.`,
      "success",
    );
    for (const warning of result.warnings.slice(0, 2)) toast(warning, "info");
  } catch (error) {
    toast(`MIDI import failed: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

function uniqueImportedName(name: string): string {
  const base = name.trim() || "MIDI";
  let candidate = base;
  let index = 2;
  while (state.project.tracks.some((track) => track.name === candidate)) {
    candidate = `${base} ${index++}`;
  }
  return candidate;
}

export function defaultExportRange(): { startTicks: number; endTicks: number } {
  if (
    state.project.loopRegion.enabled &&
    state.project.loopRegion.endTicks > state.project.loopRegion.startTicks
  ) {
    return {
      startTicks: state.project.loopRegion.startTicks,
      endTicks: state.project.loopRegion.endTicks,
    };
  }
  return { startTicks: 0, endTicks: projectEndTicks(state.project) };
}

export async function exportMixdown(
  options?: Partial<ExportOptions>,
  path?: string,
): Promise<ExportResult | null> {
  const range = defaultExportRange();
  const resolved: ExportOptions = {
    sampleRate: options?.sampleRate ?? state.project.sampleRate,
    bitDepth: options?.bitDepth ?? 24,
    channels: options?.channels ?? 2,
    startTicks: options?.startTicks ?? range.startTicks,
    endTicks: options?.endTicks ?? range.endTicks,
  };
  const target =
    path ??
    (await fileDialog.exportWav(`${fileStem(state.project.name)} Mixdown.wav`));
  if (!target) return null;
  setBusy("Rendering mixdown…");
  state.exportProgress = { progress: 0, path: target };
  store.emit("ui");
  try {
    await api.transportStop().catch(() => undefined);
    const result = await api.exportWav(clone(state.project), target, resolved);
    toast(
      `Exported ${result.durationSeconds.toFixed(2)}s · ${(result.frames / 1000).toFixed(0)}k frames · peak ${(
        20 * Math.log10(Math.max(result.peak, 0.000001))
      ).toFixed(1)} dBFS.`,
      "success",
    );
    return result;
  } catch (error) {
    toast(`Export failed: ${error}`, "error");
    return null;
  } finally {
    setBusy(null);
    state.exportProgress = null;
    store.emit("ui");
  }
}

export async function exportMidi(path?: string): Promise<void> {
  const target = path ?? (await fileDialog.exportMidi(`${fileStem(state.project.name)}.mid`));
  if (!target) return;
  setBusy("Exporting MIDI…");
  try {
    const result = await api.exportMidi(clone(state.project), target);
    toast(
      `MIDI exported · ${result.tracksWritten} track(s), ${result.notesWritten} note(s).`,
      "success",
    );
  } catch (error) {
    toast(`MIDI export failed: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function refreshDevices(): Promise<void> {
  try {
    state.devices = await api.getAudioDevices();
    state.midiDevices = await api.getMidiDevices();
    state.midiStatus = await api.getMidiStatus();
    store.emit("engine");
  } catch (error) {
    toast(`Could not enumerate devices: ${error}`, "error");
  }
}

export async function applyAudioOutput(name: string | null, sampleRate: number | null): Promise<void> {
  setBusy("Switching audio device…");
  try {
    const result = await api.setAudioOutput(name, sampleRate);
    state.devices = await api.getAudioDevices();
    await syncEngine();
    store.emit("engine");
    toast(
      `Audio output: ${result.selection.name} · ${result.selection.sampleRate} Hz · ${result.selection.channels} ch (${result.selection.sampleFormat})`,
      "success",
    );
  } catch (error) {
    toast(`Could not switch output device: ${error}`, "error");
  } finally {
    setBusy(null);
  }
}

export async function connectMidi(device: string, trackId: string): Promise<void> {
  try {
    const status = await api.connectMidiInput(device, trackId);
    state.midiStatus = status;
    store.emit("engine");
    toast(`MIDI input "${device}" connected to the selected instrument.`, "success");
  } catch (error) {
    toast(`MIDI connection failed: ${error}`, "error");
  }
}

export async function disconnectMidi(): Promise<void> {
  try {
    state.midiStatus = await api.disconnectMidiInput();
    store.emit("engine");
    toast("MIDI input disconnected.", "info");
  } catch (error) {
    toast(`MIDI disconnect failed: ${error}`, "error");
  }
}

export async function refreshMidiStatus(): Promise<void> {
  try {
    state.midiStatus = await api.getMidiStatus();
    store.emit("engine");
  } catch {
    // MIDI status is optional.
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function projectSelectionSummary(): Selection {
  return state.selection;
}

export function canUndo(): boolean {
  return history.canUndo;
}

export function canRedo(): boolean {
  return history.canRedo;
}

export function goToTime(seconds: number): void {
  const ticks = Math.round((seconds * state.project.tempo * state.project.ppq) / 60);
  void seekTicks(ticks);
}

export function zoomIn(): void {
  setArrangeZoom(state.layout.arrangeZoom * 1.25);
}

export function zoomOut(): void {
  setArrangeZoom(state.layout.arrangeZoom / 1.25);
}
