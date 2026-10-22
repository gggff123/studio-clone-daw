import * as actions from "../actions";
import { fileDialog } from "../api";
import { state, store, type ModalType } from "../store";
import type { AudioDeviceInfo, ExportResult, TrackKind } from "../types";
import { h } from "../utils/dom";
import {
  barTicks,
  clamp,
  formatBarsBeats,
  formatDateFromEpoch,
  projectEndTicks,
} from "../utils/format";
import { iconButton, rangeControl, selectBox } from "./controls";
import { effectDef, formatParam } from "./effects";
import { icon } from "./icons";

let overlay: HTMLElement | null = null;
let renderedKey = "";
let progressFill: HTMLElement | null = null;
let progressLabel: HTMLElement | null = null;
let exportResultEl: HTMLElement | null = null;

export function mountModals(): void {
  store.on("ui", onUiEvent);
  store.on("autosaves", () => {
    if (state.modal?.type === "recovery") renderModal(true);
  });
  store.on("engine", () => {
    if (state.modal?.type === "audio" || state.modal?.type === "midi") renderModal(true);
  });
  onUiEvent();
}

function modalKey(): string {
  if (!state.modal) return "";
  const payload = state.modal.payload as { effectId?: string; host?: string } | undefined;
  return `${state.modal.type}:${payload?.host ?? ""}:${payload?.effectId ?? ""}`;
}

function onUiEvent(): void {
  const key = modalKey();
  if (key === renderedKey) {
    updateProgress();
    return;
  }
  renderModal();
}

function renderModal(force = false): void {
  const key = modalKey();
  if (!state.modal) {
    overlay?.remove();
    overlay = null;
    renderedKey = "";
    return;
  }
  if (!force && key === renderedKey) {
    updateProgress();
    return;
  }
  closeModalDom();
  renderedKey = key;
  progressFill = null;
  progressLabel = null;
  exportResultEl = null;

  const modal = buildModal(state.modal.type, state.modal.payload);
  if (!modal) return;
  overlay = h("div", { class: "modal-backdrop" }, modal);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) actions.closeModal();
  });
  document.body.append(overlay);
  updateProgress();
  const firstInput = overlay.querySelector<HTMLInputElement>("input:not([type=range])");
  if (firstInput && state.modal.type === "addTrack") {
    window.setTimeout(() => {
      firstInput.focus();
      firstInput.select();
    }, 10);
  }
}

function closeModalDom(): void {
  overlay?.remove();
  overlay = null;
}

function modalShell(
  title: string,
  subtitle: string,
  body: HTMLElement,
  footer: HTMLElement | null,
  wide = false,
): HTMLElement {
  const modal = h(
    "div",
    { class: `modal ${wide ? "modal-wide" : ""}`.trim(), role: "dialog", "aria-modal": "true" },
    h(
      "div",
      { class: "modal-header" },
      h("div", { class: "modal-title-block" },
        h("div", { class: "modal-title", text: title }),
        h("div", { class: "modal-subtitle", text: subtitle }),
      ),
      iconButton("close", () => actions.closeModal(), { title: "Close", size: 13 }),
    ),
    h("div", { class: "modal-body" }, body),
    footer ? h("div", { class: "modal-footer" }, footer) : null,
  );
  return modal;
}

function buildModal(type: ModalType, payload: unknown): HTMLElement | null {
  switch (type) {
    case "audio":
      return buildAudioModal();
    case "midi":
      return buildMidiModal();
    case "export":
      return buildExportModal();
    case "recovery":
      return buildRecoveryModal();
    case "shortcuts":
      return buildShortcutsModal();
    case "about":
      return buildAboutModal();
    case "addTrack":
      return buildAddTrackModal();
    case "project":
      return buildProjectModal();
    case "effect":
      return buildEffectModal(payload as { host: string; effectId: string });
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Audio setup
// ---------------------------------------------------------------------------

function buildAudioModal(): HTMLElement {
  const devices = state.devices;
  const outputs = devices?.outputs ?? [];
  const currentName = devices?.currentOutput ?? outputs[0]?.name ?? "";
  let selectedName = currentName;
  let selectedRate =
    outputs.find((entry) => entry.name === selectedName)?.defaultSampleRate ??
    state.transport?.sampleRate ??
    state.project.sampleRate;

  const body = h("div", { class: "form-grid" });
  const footer = h("div", { class: "modal-actions" });

  const refresh = (): void => {
    body.replaceChildren();
    const device = outputs.find((entry) => entry.name === selectedName);
    body.append(
      information(
        "Audio system",
        "WASAPI (CPAL native backend). ASIO is not available in this build.",
      ),
      information(
        "Engine status",
        state.transport?.engineReady
          ? `Running · ${state.transport.sampleRate} Hz · ${state.transport.outputDevice ?? "Default output"}`
          : state.transport?.deviceError ?? "Audio engine unavailable",
      ),
      h(
        "label",
        { class: "form-field" },
        h("span", { class: "form-label", text: "Output device" }),
        selectBox(
          outputs.length
            ? outputs.map((entry) => ({
                value: entry.name,
                label: `${entry.name}${entry.isDefault ? " (Default)" : ""}`,
              }))
            : [{ value: "", label: "No output devices found" }],
          selectedName,
          (value) => {
            selectedName = value;
            const next = outputs.find((entry) => entry.name === value);
            selectedRate = next?.defaultSampleRate ?? state.project.sampleRate;
            refresh();
          },
          "wide-select",
        ),
      ),
      h(
        "label",
        { class: "form-field" },
        h("span", { class: "form-label", text: "Sample rate" }),
        selectBox(
          rateOptions(device, selectedRate).map((rate) => ({
            value: String(rate),
            label: `${rate} Hz`,
          })),
          String(selectedRate),
          (value) => {
            selectedRate = Number(value);
          },
          "wide-select",
        ),
      ),
      information(
        "Device capabilities",
        device
          ? `${device.channels} output channel(s) · default ${device.defaultSampleRate} Hz · ${device.supportedSampleRates.join(", ") || "rate list unavailable"}`
          : "No device information available.",
      ),
      information(
        "Inputs",
        devices?.inputs.length
          ? `${devices.inputs.join(", ")} — input monitoring and recording are not implemented.`
          : "No audio inputs detected. Audio recording is not implemented in this build.",
      ),
      information(
        "Buffer size",
        "Buffer size selection is not exposed by this backend yet. The device default buffer is used.",
      ),
      ...(devices?.error ? [h("div", { class: "form-error", text: devices.error })] : []),
    );
  };

  refresh();
  footer.append(
    h("button", { class: "text-btn", type: "button", text: "Refresh", onClick: () => void actions.refreshDevices() }),
    h("button", { class: "text-btn", type: "button", text: "Close", onClick: () => actions.closeModal() }),
    h("button", {
      class: "text-btn primary",
      type: "button",
      text: "Apply",
      onClick: () => {
        if (!selectedName) return;
        void actions.applyAudioOutput(selectedName, selectedRate).then(() => {
          refresh();
        });
      },
    }),
  );
  return modalShell("Studio Setup", "Audio connections and device configuration", body, footer, true);
}

function rateOptions(device: AudioDeviceInfo | undefined, fallback: number): number[] {
  const rates = new Set<number>(device?.supportedSampleRates ?? []);
  for (const rate of [44_100, 48_000, 88_200, 96_000, 176_400, 192_000]) {
    if (device?.supportedSampleRates.includes(rate)) rates.add(rate);
  }
  if (rates.size === 0) rates.add(fallback);
  if (!rates.has(fallback)) rates.add(fallback);
  return [...rates].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// MIDI setup
// ---------------------------------------------------------------------------

function buildMidiModal(): HTMLElement {
  const devices = state.midiDevices;
  const status = state.midiStatus;
  const candidates = state.project.tracks.filter(
    (track) => track.kind === "instrument" || track.kind === "midi",
  );
  const defaultTrack = state.selection.trackId &&
    candidates.some((track) => track.id === state.selection.trackId)
    ? state.selection.trackId
    : candidates[0]?.id ?? "";
  let device = status?.device ?? devices?.inputs[0] ?? "";
  let targetTrack = status?.targetTrackId ?? defaultTrack;

  const body = h(
    "div",
    { class: "form-grid" },
    information("MIDI input", devices?.error ? `Unavailable: ${devices.error}` : status?.connected ? `Connected to ${status.device}` : "Not connected"),
    h(
      "label",
      { class: "form-field" },
      h("span", { class: "form-label", text: "Input device" }),
      selectBox(
        devices?.inputs.length
          ? devices.inputs.map((entry) => ({ value: entry, label: entry }))
          : [{ value: "", label: "No MIDI inputs detected" }],
        device,
        (value) => {
          device = value;
        },
        "wide-select",
      ),
    ),
    h(
      "label",
      { class: "form-field" },
      h("span", { class: "form-label", text: "Instrument target" }),
      selectBox(
        candidates.length
          ? candidates.map((entry) => ({ value: entry.id, label: entry.name }))
          : [{ value: "", label: "No instrument tracks" }],
        targetTrack,
        (value) => {
          targetTrack = value;
        },
        "wide-select",
      ),
    ),
    information(
      "Live input",
      "Incoming notes are sent to the selected instrument for live auditioning. MIDI recording and controller automation are not implemented yet.",
    ),
    information(
      "MIDI outputs",
      devices?.outputs.length ? devices.outputs.join(", ") : "No MIDI outputs detected. MIDI file export does not require one.",
    ),
  );

  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", { class: "text-btn", type: "button", text: "Refresh", onClick: () => void actions.refreshDevices() }),
    h("button", {
      class: "text-btn",
      type: "button",
      text: "Disconnect",
      disabled: !status?.connected,
      onClick: () => {
        void actions.disconnectMidi().then(() => actions.closeModal());
      },
    }),
    h("button", {
      class: "text-btn primary",
      type: "button",
      text: "Connect",
      disabled: !device || !targetTrack,
      onClick: () => {
        if (!device || !targetTrack) return;
        void actions.connectMidi(device, targetTrack).then(() => actions.closeModal());
      },
    }),
  );
  return modalShell("MIDI Connections", "MIDI input devices and instrument routing", body, footer);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function buildExportModal(): HTMLElement {
  const project = state.project;
  const bar = barTicks(project.ppq, project.timeSignature);
  const defaultRange = actions.defaultExportRange();
  let rangeMode: "project" | "cycle" | "custom" = project.loopRegion.enabled ? "cycle" : "project";
  let startBar = Math.floor(defaultRange.startTicks / bar) + 1;
  let endBar = Math.max(startBar, Math.ceil(defaultRange.endTicks / bar));
  let sampleRate = project.sampleRate;
  let bitDepth = 24;
  let channels = 2;
  let exporting = false;

  const startInput = h("input", {
    class: "number-input",
    type: "number",
    min: "1",
    value: String(startBar),
    onInput: () => {
      startBar = Math.max(1, Number(startInput.value) || 1);
      if (endBar < startBar) {
        endBar = startBar;
        endInput.value = String(endBar);
      }
      updateEstimate();
    },
  });
  const endInput = h("input", {
    class: "number-input",
    type: "number",
    min: "1",
    value: String(endBar),
    onInput: () => {
      endBar = Math.max(startBar, Number(endInput.value) || 1);
      endInput.value = String(endBar);
      updateEstimate();
    },
  });
  const estimate = h("span", { class: "field-value", text: "" });

  const rangeField = h(
    "label",
    { class: "form-field" },
    h("span", { class: "form-label", text: "Range" }),
    h(
      "div",
      { class: "segmented" },
      segment("Whole Project", rangeMode === "project", () => setRange("project")),
      segment("Cycle", rangeMode === "cycle", () => setRange("cycle")),
      segment("Custom", (rangeMode as string) === "custom", () => setRange("custom")),
    ),
  );

  const customRow = h(
    "div",
    { class: "form-row bars-row" },
    h("label", { class: "inline-field" }, h("span", { text: "Start bar" }), startInput),
    h("label", { class: "inline-field" }, h("span", { text: "Last bar" }), endInput),
    h("div", {
      class: "hint-block",
      text: "The last bar is included in the rendered range.",
    }),
  );

  const progress = h(
    "div",
    { class: "export-progress" },
    h("div", { class: "progress-track" }, h("div", { class: "progress-fill" })),
    h("div", { class: "progress-label", text: "Idle" }),
  );
  progress.style.display = "none";
  progressFill = progress.querySelector(".progress-fill");
  progressLabel = progress.querySelector(".progress-label");
  exportResultEl = h("div", { class: "export-result" });

  function setRange(mode: "project" | "cycle" | "custom"): void {
    rangeMode = mode;
    const range = actions.defaultExportRange();
    if (mode === "cycle") {
      startBar = Math.floor(range.startTicks / bar) + 1;
      endBar = Math.max(startBar, Math.ceil(range.endTicks / bar));
    } else if (mode === "project") {
      startBar = 1;
      endBar = Math.max(1, Math.ceil(projectEndTicks(project) / bar));
    }
    startInput.value = String(startBar);
    endInput.value = String(endBar);
    for (const button of rangeField.querySelectorAll<HTMLElement>(".segment")) {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    }
    customRow.style.display = mode === "custom" ? "" : "none";
    updateEstimate();
  }

  function resolveRange(): { startTicks: number; endTicks: number } {
    if (rangeMode === "project") {
      return { startTicks: 0, endTicks: Math.max(projectEndTicks(project), project.ppq) };
    }
    if (rangeMode === "cycle") {
      return {
        startTicks: project.loopRegion.startTicks,
        endTicks: Math.max(project.loopRegion.endTicks, project.loopRegion.startTicks + project.ppq),
      };
    }
    return {
      startTicks: Math.max(0, (startBar - 1) * bar),
      endTicks: Math.max(startBar, endBar) * bar,
    };
  }

  function updateEstimate(): void {
    const range = resolveRange();
    const seconds =
      ((range.endTicks - range.startTicks) / project.ppq) * (60 / project.tempo);
    const firstBar = Math.floor(range.startTicks / bar) + 1;
    const lastBar = Math.max(firstBar, Math.ceil(range.endTicks / bar));
    estimate.textContent = `Bars ${firstBar}–${lastBar} (${lastBar - firstBar + 1} bar${
      lastBar === firstBar ? "" : "s"
    }) · ${seconds.toFixed(2)} s`;
  }

  setRange(rangeMode);
  updateEstimate();

  const body = h(
    "div",
    { class: "form-grid" },
    rangeField,
    customRow,
    h(
      "div",
      { class: "form-row" },
      h(
        "label",
        { class: "form-field" },
        h("span", { class: "form-label", text: "Sample rate" }),
        selectBox(
          [44_100, 48_000, 88_200, 96_000, 176_400, 192_000].map((rate) => ({
            value: String(rate),
            label: `${rate} Hz`,
          })),
          String(sampleRate),
          (value) => {
            sampleRate = Number(value);
          },
        ),
      ),
      h(
        "label",
        { class: "form-field" },
        h("span", { class: "form-label", text: "Bit depth" }),
        selectBox(
          [
            { value: "16", label: "16-bit PCM" },
            { value: "24", label: "24-bit PCM" },
            { value: "32", label: "32-bit float" },
          ],
          String(bitDepth),
          (value) => {
            bitDepth = Number(value);
          },
        ),
      ),
      h(
        "label",
        { class: "form-field" },
        h("span", { class: "form-label", text: "Channels" }),
        selectBox(
          [
            { value: "2", label: "Stereo" },
            { value: "1", label: "Mono" },
          ],
          String(channels),
          (value) => {
            channels = Number(value);
          },
        ),
      ),
    ),
    h("div", { class: "form-field" }, h("span", { class: "form-label", text: "Estimated length" }), estimate),
    information(
      "Render engine",
      "The mix is rendered offline through the same track graph, inserts, group routing, master bus and limiter used for live playback.",
    ),
    progress,
    exportResultEl,
  );

  const exportButton = h(
    "button",
    {
      class: "text-btn primary",
      type: "button",
      text: "Export WAV…",
      onClick: () => {
        if (exporting) return;
        const range = resolveRange();
        if (range.endTicks <= range.startTicks) {
          exportResultEl!.replaceChildren(h("div", { class: "form-error", text: "The export range is empty." }));
          return;
        }
        exporting = true;
        exportButton.textContent = "Rendering…";
        progress.style.display = "";
        progressFill!.style.width = "0%";
        progressLabel!.textContent = "Preparing render…";
        exportResultEl!.replaceChildren();
        void actions
          .exportMixdown({
            sampleRate,
            bitDepth,
            channels,
            startTicks: range.startTicks,
            endTicks: range.endTicks,
          })
          .then((result) => {
            if (result) showExportResult(result);
          })
          .finally(() => {
            exporting = false;
            exportButton.textContent = "Export WAV…";
            progress.style.display = "none";
          });
      },
    },
  );

  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", { class: "text-btn", type: "button", text: "Close", onClick: () => actions.closeModal() }),
    exportButton,
  );
  return modalShell("Export Audio Mixdown", "Render the project to a PCM or float WAV file", body, footer, true);
}

function showExportResult(result: ExportResult): void {
  if (!exportResultEl) return;
  exportResultEl.replaceChildren(
    h("div", { class: "export-success" },
      h("div", { class: "export-success-title", text: "Export complete" }),
      h("div", { class: "export-success-path", text: result.path }),
      h("div", { class: "export-success-detail", text: `${result.durationSeconds.toFixed(2)} s · ${result.sampleRate} Hz · ${result.bitDepth}-bit ${result.bitDepth === 32 ? "float" : "PCM"} · ${result.channels === 2 ? "stereo" : "mono"} · ${result.frames.toLocaleString()} frames` }),
      h("div", { class: "export-success-detail", text: `Peak ${(20 * Math.log10(Math.max(result.peak, 0.000001))).toFixed(1)} dBFS` }),
    ),
  );
}

function segment(label: string, active: boolean, onClick: () => void): HTMLElement {
  return h("button", {
    class: `segment ${active ? "is-active" : ""}`.trim(),
    type: "button",
    text: label,
    dataset: { mode: label.toLowerCase().split(" ")[0] === "whole" ? "project" : label.toLowerCase() },
    onClick,
  });
}

function updateProgress(): void {
  const progress = state.exportProgress;
  if (!progressFill || !progressLabel || !progress) return;
  progressFill.style.width = `${clamp(progress.progress, 0, 1) * 100}%`;
  progressLabel.textContent = `Rendering… ${Math.round(progress.progress * 100)}% · ${progress.path}`;
  const container = progressFill.closest<HTMLElement>(".export-progress");
  if (container) container.style.display = "";
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function buildRecoveryModal(): HTMLElement {
  const autosaves = [...state.autosaves].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const list = h("div", { class: "recovery-list" });
  if (autosaves.length === 0) {
    list.append(h("div", { class: "media-empty", text: "No autosave files are available." }));
  }
  for (const entry of autosaves) {
    const date = new Date(entry.modifiedAt);
    list.append(
      h(
        "div",
        { class: "recovery-row" },
        h("div", { class: "recovery-info" },
          h("div", { class: "recovery-name", text: entry.projectName }),
          h("div", { class: "recovery-meta", text: `${Number.isNaN(date.getTime()) ? entry.modifiedAt : date.toLocaleString()} · ${Math.round(entry.size / 1024)} KB` }),
          h("div", { class: "recovery-path", text: entry.path, title: entry.path }),
        ),
        h("div", { class: "recovery-actions" },
          h("button", {
            class: "text-btn primary",
            type: "button",
            text: "Recover",
            onClick: () => void actions.loadAutosave(entry.path),
          }),
          h("button", {
            class: "text-btn danger",
            type: "button",
            text: "Delete",
            onClick: () => void actions.deleteAutosave(entry.path),
          }),
        ),
      ),
    );
  }

  const body = h(
    "div",
    { class: "form-grid" },
    h("div", {
      class: "hint-block",
      text: "Autosaves are created every two minutes while the project has unsaved changes. Recovered projects open as unsaved and must be saved explicitly.",
    }),
    list,
  );
  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", {
      class: "text-btn",
      type: "button",
      text: "Refresh",
      onClick: () => void actions.refreshAutosaves(),
    }),
    h("button", {
      class: "text-btn danger",
      type: "button",
      text: "Delete All…",
      disabled: autosaves.length === 0,
      onClick: async () => {
        const confirmed = await fileDialog.confirm(
          `Delete all ${autosaves.length} autosave file(s)? This cannot be undone.`,
          "Delete Autosaves",
        );
        if (!confirmed) return;
        for (const entry of autosaves) await actions.deleteAutosave(entry.path);
      },
    }),
    h("button", { class: "text-btn", type: "button", text: "Close", onClick: () => actions.closeModal() }),
  );
  return modalShell("Autosave & Recovery", "Restore a project captured by the autosave system", body, footer, true);
}

// ---------------------------------------------------------------------------
// Shortcuts / About
// ---------------------------------------------------------------------------

const SHORTCUTS: Array<[string, string]> = [
  ["Space", "Play / pause"],
  ["Stop button / F12", "Stop and return to start"],
  ["Home", "Go to project start"],
  ["L", "Toggle cycle (loop)"],
  ["M", "Toggle metronome"],
  ["Ctrl+N", "New project"],
  ["Ctrl+O", "Open project"],
  ["Ctrl+S", "Save project"],
  ["Ctrl+Shift+S", "Save project as"],
  ["Ctrl+E", "Export audio mixdown"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
  ["Ctrl+A", "Select all notes in the active part"],
  ["Ctrl+D", "Duplicate selected clip, part or notes"],
  ["Delete / Backspace", "Delete selection"],
  ["1 / 2 / 3", "Select / Draw / Split tool"],
  ["Q", "Quantize selected notes"],
  ["Ctrl+= / Ctrl+-", "Zoom timeline"],
  ["Tab", "Toggle piano roll / MixConsole"],
  ["Esc", "Close modal / clear selection"],
  ["Ctrl+Mouse wheel", "Zoom under the pointer"],
];

function buildShortcutsModal(): HTMLElement {
  const table = h("div", { class: "shortcut-table" });
  for (const [keys, description] of SHORTCUTS) {
    table.append(
      h("div", { class: "shortcut-row" },
        h("kbd", { class: "shortcut-keys", text: keys }),
        h("span", { class: "shortcut-desc", text: description }),
      ),
    );
  }
  return modalShell(
    "Key Commands",
    "Keyboard shortcuts available in this build",
    table,
    h("div", { class: "modal-actions" }, h("button", { class: "text-btn", type: "button", text: "Close", onClick: () => actions.closeModal() })),
    true,
  );
}

function buildAboutModal(): HTMLElement {
  const info = state.appInfo;
  const body = h(
    "div",
    { class: "about-body" },
    h("div", { class: "about-mark", text: "SC" }),
    h("div", { class: "about-name", text: "Studio Clone" }),
    h("div", { class: "about-version", text: info ? `Version ${info.version} · ${info.os} ${info.arch}` : "Version unavailable" }),
    h("div", { class: "about-copy", text: "An original, Cubase-inspired digital audio workstation built with Tauri 2, Rust and TypeScript. Audio playback, mixing, MIDI editing, project files and WAV export are implemented in this repository." }),
    h("div", { class: "about-grid" },
      infoRow("Project format", `v${info?.projectFormatVersion ?? 1}`),
      infoRow("Backend", info?.backendReady ? "Rust / CPAL" : "Unavailable"),
      infoRow("Audio host", "WASAPI through CPAL"),
      infoRow("Renderer", "Native mix graph + offline WAV"),
    ),
    h("div", { class: "about-note", text: "No Steinberg code, binaries or assets are used. Cubase is a trademark of Steinberg Media Technologies GmbH; this project is an independent educational clone." }),
  );
  return modalShell(
    "About Studio Clone",
    "Independent DAW project",
    body,
    h("div", { class: "modal-actions" },
      h("button", { class: "text-btn", type: "button", text: "Key Commands", onClick: () => actions.openModal("shortcuts") }),
      h("button", { class: "text-btn primary", type: "button", text: "Close", onClick: () => actions.closeModal() }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Add track
// ---------------------------------------------------------------------------

const TRACK_CHOICES: Array<{ kind: TrackKind; title: string; detail: string; icon: string }> = [
  { kind: "audio", title: "Audio", detail: "Audio clips and imported media", icon: "wave" },
  { kind: "instrument", title: "Instrument", detail: "Built-in synthesizer and MIDI parts", icon: "synth" },
  { kind: "midi", title: "MIDI", detail: "MIDI parts with the built-in synth", icon: "keyboard" },
  { kind: "group", title: "Group", detail: "Sum tracks through one channel", icon: "layers" },
  { kind: "fx", title: "FX", detail: "Parallel-style effect bus channel", icon: "sparkle" },
];

function buildAddTrackModal(): HTMLElement {
  let selected: TrackKind = "instrument";
  const nameInput = h("input", {
    class: "name-input",
    type: "text",
    placeholder: "Track name (optional)",
    spellcheck: false,
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter") addNow();
      event.stopPropagation();
    },
  });
  const grid = h("div", { class: "track-choice-grid" });
  const cards = new Map<TrackKind, HTMLElement>();
  for (const choice of TRACK_CHOICES) {
    const card = h(
      "button",
      {
        class: `track-choice ${choice.kind === selected ? "is-active" : ""}`.trim(),
        type: "button",
        onClick: () => {
          selected = choice.kind;
          for (const [kind, element] of cards) element.classList.toggle("is-active", kind === selected);
          nameInput.placeholder = `${choice.title} track name (optional)`;
        },
      },
      h("span", { class: "track-choice-icon" }, icon(choice.icon, 20)),
      h("span", { class: "track-choice-title", text: choice.title }),
      h("span", { class: "track-choice-detail", text: choice.detail }),
    );
    cards.set(choice.kind, card);
    grid.append(card);
  }

  function addNow(): void {
    const track = actions.addTrack(selected, nameInput.value.trim() || undefined);
    if (track) actions.closeModal();
  }

  const body = h(
    "div",
    { class: "form-grid" },
    grid,
    h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Name" }), nameInput),
    h("div", {
      class: "hint-block",
      text: "Group and FX channels can be selected as the output of other tracks in the inspector or MixConsole. The engine prevents routing cycles.",
    }),
  );
  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", { class: "text-btn", type: "button", text: "Cancel", onClick: () => actions.closeModal() }),
    h("button", { class: "text-btn primary", type: "button", text: "Add Track", onClick: addNow }),
  );
  return modalShell("Add Track", "Choose a channel type for the new track", body, footer, true);
}

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

function buildProjectModal(): HTMLElement {
  const project = state.project;
  const bar = barTicks(project.ppq, project.timeSignature);
  const name = h("input", { class: "name-input", type: "text", value: project.name, spellcheck: false });
  const tempo = h("input", { class: "number-input", type: "number", min: "20", max: "300", step: "0.5", value: String(project.tempo) });
  const startBar = h("input", { class: "number-input", type: "number", min: "1", value: String(Math.floor(project.loopRegion.startTicks / bar) + 1) });
  const endBar = h("input", { class: "number-input", type: "number", min: "1", value: String(Math.ceil(project.loopRegion.endTicks / bar)) });
  const metronome = h("input", { type: "checkbox", checked: project.metronome });
  let sampleRate = project.sampleRate;
  let signatureNumerator = project.timeSignature.numerator;
  let signatureDenominator = project.timeSignature.denominator;

  const body = h(
    "div",
    { class: "form-grid" },
    h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Project name" }), name),
    h(
      "div",
      { class: "form-row" },
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Tempo (BPM)" }), tempo),
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Sample rate (metadata)" }),
        selectBox(
          [44_100, 48_000, 88_200, 96_000, 176_400, 192_000].map((rate) => ({ value: String(rate), label: `${rate} Hz` })),
          String(project.sampleRate),
          (value) => {
            sampleRate = Number(value);
          },
        ),
      ),
    ),
    h(
      "div",
      { class: "form-row" },
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Time signature" }),
        h("div", { class: "signature-row" },
          selectBox(["2", "3", "4", "5", "6", "7", "8", "9", "12"].map((value) => ({ value, label: value })), String(project.timeSignature.numerator), (value) => {
            signatureNumerator = Number(value);
          }, "sig-num"),
          h("span", { class: "signature-slash", text: "/" }),
          selectBox(["2", "4", "8", "16"].map((value) => ({ value, label: value })), String(project.timeSignature.denominator), (value) => {
            signatureDenominator = Number(value);
          }, "sig-den"),
        ),
      ),
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Metronome" }), metronome),
    ),
    h(
      "div",
      { class: "form-row" },
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Cycle start bar" }), startBar),
      h("label", { class: "form-field" }, h("span", { class: "form-label", text: "Cycle end bar" }), endBar),
    ),
    h("div", {
      class: "hint-block",
      text: "Tempo is constant in this build. Time signature and tempo are stored in the project file. The sample rate field is project metadata; the live engine uses the selected device rate.",
    }),
  );

  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", { class: "text-btn", type: "button", text: "Cancel", onClick: () => actions.closeModal() }),
    h("button", {
      class: "text-btn primary",
      type: "button",
      text: "Apply",
      onClick: () => {
        if (name.value.trim()) actions.setProjectName(name.value.trim());
        actions.setTempo(Number(tempo.value) || project.tempo);
        actions.setTimeSignature(signatureNumerator, signatureDenominator);
        actions.setProjectSampleRate(sampleRate);
        actions.setLoop(
          project.loopRegion.enabled,
          (Math.max(1, Number(startBar.value) || 1) - 1) * bar,
          Math.max(1, Number(endBar.value) || 1) * bar,
        );
        if (metronome.checked !== state.project.metronome) actions.setMetronome(metronome.checked);
        actions.closeModal();
      },
    }),
  );
  return modalShell("Project Setup", "Project name, timeline and metadata", body, footer, true);
}

// ---------------------------------------------------------------------------
// Effect editor
// ---------------------------------------------------------------------------

function buildEffectModal(payload: { host: string; effectId: string }): HTMLElement | null {
  const insert = actions.findInsert(payload.host, payload.effectId);
  if (!insert) {
    window.setTimeout(() => actions.closeModal(), 0);
    return null;
  }
  const def = effectDef(insert.kind);
  const hostName =
    payload.host === "master"
      ? "Master"
      : state.project.tracks.find((track) => track.id === payload.host)?.name ?? "Track";

  const controls = h("div", { class: "effect-controls" });
  for (const param of def.params) {
    const value = insert.params[param.key] ?? param.default;
    const control = rangeControl({
      value,
      min: param.min,
      max: param.max,
      step: param.step,
      label: param.label,
      format: (next) => formatParam(param, next),
      className: "effect-param",
      onStart: () => actions.beginGesture(),
      onPreview: (next) =>
        actions.setInsertParam(payload.host, payload.effectId, param.key, next, true),
      onEnd: () => actions.endEffectGesture(),
    });
    if (param.options) {
      // Option-style parameters still use a slider; the formatted value shows
      // the selected mode, and the step of 1 snap to valid modes.
    }
    controls.append(control.element);
  }

  const body = h(
    "div",
    { class: "form-grid" },
    h("div", { class: "effect-head" },
      h("div", { class: "effect-title", text: def.name }),
      h("div", { class: "effect-host", text: hostName }),
      h("div", { class: "effect-description", text: def.description }),
    ),
    h(
      "div",
      { class: "effect-toolbar" },
      h("button", {
        class: `text-btn ${insert.enabled ? "active" : ""}`.trim(),
        type: "button",
        text: insert.enabled ? "Bypass" : "Enable",
        onClick: () => actions.toggleInsert(payload.host, payload.effectId),
      }),
      h("button", {
        class: "text-btn",
        type: "button",
        text: "Move Up",
        onClick: () => actions.moveInsert(payload.host, payload.effectId, -1),
      }),
      h("button", {
        class: "text-btn",
        type: "button",
        text: "Move Down",
        onClick: () => actions.moveInsert(payload.host, payload.effectId, 1),
      }),
    ),
    controls,
    h("div", {
      class: "hint-block",
      text: "Parameters are applied on the native audio thread from the current project snapshot and are also used by offline export. Delay/reverb tails persist across blocks.",
    }),
  );

  const footer = h(
    "div",
    { class: "modal-actions" },
    h("button", {
      class: "text-btn danger",
      type: "button",
      text: "Remove Insert",
      onClick: () => {
        actions.removeInsert(payload.host, payload.effectId);
        actions.closeModal();
      },
    }),
    h("button", { class: "text-btn primary", type: "button", text: "Done", onClick: () => actions.closeModal() }),
  );
  return modalShell(def.name, "Insert effect editor", body, footer);
}

function information(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "info-block" },
    h("span", { class: "form-label", text: label }),
    h("span", { class: "info-value", text: value }),
  );
}

function infoRow(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "about-row" },
    h("span", { class: "about-label", text: label }),
    h("span", { class: "about-value", text: value }),
  );
}

export function openExportModal(): void {
  actions.openModal("export");
}

export function modalIsOpen(): boolean {
  return state.modal !== null;
}

export function closeTopModal(): boolean {
  if (!state.modal) return false;
  actions.closeModal();
  return true;
}

export function formatAutosaveAge(modifiedAt: string): string {
  const timestamp = Date.parse(modifiedAt);
  if (Number.isNaN(timestamp)) return modifiedAt;
  return formatDateFromEpoch(timestamp / 1000);
}
