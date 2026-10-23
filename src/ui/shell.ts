import * as actions from "../actions";
import { api, fileDialog } from "../api";
import {
  DEFAULT_BOTTOM_HEIGHT,
  MIXER_MIN_BOTTOM_HEIGHT,
  MIN_BOTTOM_HEIGHT,
  state,
  store,
} from "../store";
import { h, isEditableTarget } from "../utils/dom";
import {
  clamp,
  formatBarsBeats,
  formatClock,
  peakToDb,
  projectEndTicks,
} from "../utils/format";
import { iconButton, selectBox } from "./controls";
import { icon } from "./icons";
import { menuButton, type MenuItem } from "./menu";
import { mountArrangement } from "./arrangement";
import { mountInspector } from "./inspector";
import { mountMedia } from "./media";
import { mountMixer } from "./mixer";
import { mountPiano, refreshPiano } from "./piano";
import { mountModals } from "./modals";

interface ToolbarRefs {
  projectName: HTMLElement;
  projectPath: HTMLElement;
  positionBars: HTMLElement;
  positionClock: HTMLElement;
  tempo: HTMLInputElement;
  signature: HTMLButtonElement;
  play: HTMLButtonElement;
  record: HTMLButtonElement;
  stop: HTMLButtonElement;
  loop: HTMLButtonElement;
  metro: HTMLButtonElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
  snap: HTMLSelectElement;
  save: HTMLButtonElement;
  tools: Record<string, HTMLButtonElement>;
  pianoToggle: HTMLButtonElement;
  mixerToggle: HTMLButtonElement;
  engineDot: HTMLElement;
  device: HTMLElement;
  masterFill: HTMLElement;
  masterPeak: HTMLElement;
  masterMeter: HTMLElement;
}

interface StatusRefs {
  path: HTMLElement;
  dirty: HTMLElement;
  selection: HTMLElement;
  engine: HTMLElement;
  device: HTMLElement;
  tempo: HTMLElement;
  tracks: HTMLElement;
  savings: HTMLElement;
  position: HTMLElement;
}

interface ShellRefs {
  root: HTMLElement;
  leftPanel: HTMLElement;
  leftResizer: HTMLElement;
  bottomPanel: HTMLElement;
  bottomResizer: HTMLElement;
  inspectorHost: HTMLElement;
  mediaHost: HTMLElement;
  pianoHost: HTMLElement;
  mixerHost: HTMLElement;
  leftTabs: HTMLButtonElement[];
  bottomTabs: HTMLButtonElement[];
  toolbar: ToolbarRefs;
  status: StatusRefs;
  toastHost: HTMLElement;
  busy: HTMLElement;
  busyText: HTMLElement;
}

let refs: ShellRefs | null = null;

export function mountShell(root: HTMLElement): void {
  root.replaceChildren();
  root.classList.add("app-shell");

  const toolbar = buildToolbar();
  const leftTabs: HTMLButtonElement[] = [];
  const inspectorHost = h("div", { class: "panel-host inspector-host" });
  const mediaHost = h("div", { class: "panel-host media-host" });
  const leftContent = h("div", { class: "left-content" }, inspectorHost, mediaHost);
  const leftTabsBar = h("div", { class: "panel-tabs left-tabs" });
  for (const [tab, label, iconName] of [
    ["inspector", "Inspector", "sliders"],
    ["media", "Media", "folder"],
  ] as const) {
    const button = h(
      "button",
      {
        class: "panel-tab",
        type: "button",
        title: `${label} panel`,
        onClick: () => actions.setLeftTab(tab),
      },
      icon(iconName, 12),
      h("span", { text: label }),
    );
    leftTabs.push(button);
    leftTabsBar.append(button);
  }
  const leftPanel = h("aside", { class: "left-panel" }, leftTabsBar, leftContent);
  const leftResizer = h("div", { class: "resizer v-resizer", title: "Drag to resize · double-click to reset" });

  const arrangeHost = h("section", { class: "arrange-host" });
  const pianoHost = h("div", { class: "panel-host piano-host" });
  const mixerHost = h("div", { class: "panel-host mixer-host" });
  const bottomTabsBar = h("div", { class: "panel-tabs bottom-tabs" });
  const bottomTabs: HTMLButtonElement[] = [];
  for (const [tab, label, iconName] of [
    ["piano", "Piano Roll", "keyboard"],
    ["mixer", "MixConsole", "mixer"],
  ] as const) {
    const button = h(
      "button",
      {
        class: "panel-tab",
        type: "button",
        title: `${label} panel`,
        onClick: () => {
          actions.setBottomTab(tab);
          if (tab === "piano") refreshPiano();
        },
      },
      icon(iconName, 12),
      h("span", { text: label }),
    );
    bottomTabs.push(button);
    bottomTabsBar.append(button);
  }
  bottomTabsBar.append(h("div", { class: "toolbar-spacer" }));
  bottomTabsBar.append(
    iconButton("close", () => actions.setBottomTab("none"), {
      title: "Hide lower zone",
      size: 12,
      className: "panel-close",
    }),
  );
  const bottomPanel = h(
    "section",
    { class: "bottom-panel" },
    bottomTabsBar,
    h("div", { class: "bottom-content" }, pianoHost, mixerHost),
  );
  const bottomResizer = h("div", {
    class: "resizer h-resizer",
    title: "Drag to resize · double-click to reset",
  });

  const center = h("main", { class: "center-column" }, arrangeHost, bottomResizer, bottomPanel);
  const workspace = h("div", { class: "workspace" }, leftPanel, leftResizer, center);
  const status = buildStatusBar();
  const toastHost = h("div", { class: "toast-host" });
  const busyText = h("span", { class: "busy-text", text: "" });
  const busy = h("div", { class: "busy-indicator" }, h("span", { class: "spinner" }), busyText);

  const shell = h(
    "div",
    { class: "shell" },
    toolbar.element,
    workspace,
    status.element,
    toastHost,
    busy,
  );
  root.append(shell);

  refs = {
    root,
    leftPanel,
    leftResizer,
    bottomPanel,
    bottomResizer,
    inspectorHost,
    mediaHost,
    pianoHost,
    mixerHost,
    leftTabs,
    bottomTabs,
    toolbar: toolbar.refs,
    status: status.refs,
    toastHost,
    busy,
    busyText,
  };

  mountArrangement(arrangeHost);
  mountInspector(inspectorHost);
  mountMedia(mediaHost);
  mountPiano(pianoHost);
  mountMixer(mixerHost);
  mountModals();

  wireResizers();
  wireKeyboard();
  wireCloseGuard();

  store.on("project", () => {
    updateProjectChrome();
    updateUndoRedo();
  });
  store.on("selection", updateSelectionChrome);
  store.on("layout", applyLayout);
  store.on("transport", updateTransportChrome);
  store.on("engine", updateEngineChrome);
  store.on("ui", updateUiChrome);
  store.on("autosaves", updateStatus);
  store.on("toasts", renderToasts);

  applyLayout();
  updateProjectChrome();
  updateTransportChrome();
  updateEngineChrome();
  updateUndoRedo();
  updateSelectionChrome();
  updateUiChrome();
  renderToasts();
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function buildToolbar(): { element: HTMLElement; refs: ToolbarRefs } {
  const projectName = h("span", { class: "project-name", text: state.project.name });
  const projectPath = h("span", { class: "project-location", text: "Unsaved project" });
  const brand = h(
    "div",
    { class: "brand" },
    h("span", { class: "brand-mark", text: "SC" }),
    h("div", { class: "brand-text" }, h("span", { class: "brand-name", text: "STUDIO CLONE" }), projectName),
  );

  const menus = h(
    "nav",
    { class: "main-menu" },
    menuButton("File", fileMenu),
    menuButton("Edit", editMenu),
    menuButton("Project", projectMenu),
    menuButton("Settings", settingsMenu),
  );

  const toolGroup = h("div", { class: "tool-group", role: "group", "aria-label": "Edit tools" });
  const tools: Record<string, HTMLButtonElement> = {};
  for (const [tool, iconName, title] of [
    ["select", "cursor", "Select tool (1)"],
    ["draw", "pencil", "Draw tool (2)"],
    ["split", "scissors", "Split tool (3)"],
  ] as const) {
    const button = iconButton(iconName, () => actions.setTool(tool), {
      title,
      size: 14,
      active: state.layout.tool === tool,
    });
    tools[tool] = button;
    toolGroup.append(button);
  }

  const snap = h("select", {
    class: "snap-select",
    title: "Grid snap",
    onChange: () => actions.setSnap(Number(snap.value)),
  });
  const snapWrap = h(
    "label",
    { class: "snap-wrap", title: "Grid snap (hold Alt to bypass)" },
    icon("grid", 12),
    snap,
  );

  const positionBars = h("span", { class: "position-bars", text: "1.1.1" });
  const positionClock = h("span", { class: "position-clock", text: "00:00.000" });
  const tempo = h("input", {
    class: "tempo-input",
    type: "number",
    min: "20",
    max: "300",
    step: "0.5",
    value: String(state.project.tempo),
    title: "Project tempo (BPM)",
    onChange: () => {
      const value = Number(tempo.value);
      if (Number.isFinite(value)) actions.setTempo(value);
      else tempo.value = String(state.project.tempo);
    },
    onKeydown: (event: KeyboardEvent) => event.stopPropagation(),
  });
  const signature = h(
    "button",
    {
      class: "signature-btn",
      type: "button",
      text: `${state.project.timeSignature.numerator}/${state.project.timeSignature.denominator}`,
      title: "Project setup",
      onClick: () => actions.openModal("project"),
    },
  );

  const rewind = iconButton("rewind", () => void actions.returnToStart(), {
    title: "Return to start (Home)",
    className: "transport-btn",
    size: 15,
  });
  const stop = iconButton("stop", () => void actions.transportStop(), {
    title: "Stop and return to start (F12)",
    className: "transport-btn",
    size: 15,
  });
  const play = iconButton("play", () => void actions.transportToggle(), {
    title: "Play / pause (Space)",
    className: "transport-btn play-btn",
    size: 17,
  });
  const record = iconButton("record", () => {
      void actions.toggleAudioRecording();
    }, {
      title: "Record to armed audio track",
      className: "transport-btn record-btn",
      size: 14,
    });
  const loop = iconButton("loop", () => void actions.toggleLoop(), {
    title: "Cycle / loop (L)",
    className: "transport-btn",
    size: 15,
    active: state.project.loopRegion.enabled,
  });
  const metro = iconButton("metronome", () => void actions.toggleMetronome(), {
    title: "Metronome (M)",
    className: "transport-btn",
    size: 15,
    active: state.project.metronome,
  });

  const transport = h(
    "div",
    { class: "transport-center" },
    h("div", { class: "transport-buttons" }, rewind, stop, play, record, loop, metro),
    h(
      "div",
      { class: "position-display", title: "Bars · beats · sixteenths / clock" },
      h("div", { class: "position-main" }, positionBars, positionClock),
      h("div", { class: "position-sub" }, tempo, h("span", { class: "tempo-unit", text: "BPM" }), signature),
    ),
  );

  const undo = iconButton("undo", () => actions.undo(), { title: "Undo (Ctrl+Z)", size: 14 });
  const redo = iconButton("redo", () => actions.redo(), { title: "Redo (Ctrl+Shift+Z)", size: 14 });
  const save = iconButton("save", () => void actions.saveProject(), {
    title: "Save project (Ctrl+S)",
    size: 14,
  });
  const audio = iconButton("settings", () => actions.openModal("audio"), {
    title: "Audio connections",
    size: 14,
  });
  const midi = iconButton("music", () => actions.openModal("midi"), {
    title: "MIDI connections",
    size: 14,
  });
  const help = iconButton("help", () => actions.openModal("shortcuts"), {
    title: "Key commands",
    size: 14,
  });
  const pianoToggle = iconButton("keyboard", () => {
      actions.setBottomTab(state.layout.bottomTab === "piano" ? "none" : "piano");
      if (state.layout.bottomTab === "piano") refreshPiano();
    }, {
      title: "Show / hide piano roll",
      size: 14,
      active: state.layout.bottomTab === "piano",
    });
  const mixerToggle = iconButton("mixer", () => {
      actions.setBottomTab(state.layout.bottomTab === "mixer" ? "none" : "mixer");
    }, {
      title: "Show / hide MixConsole",
      size: 14,
      active: state.layout.bottomTab === "mixer",
    });

  const engineDot = h("span", { class: "engine-dot", title: "Audio engine" });
  const device = h("span", { class: "device-label", text: "Audio engine" });
  const engine = h("div", { class: "engine-status" }, engineDot, device);

  const masterFill = h("div", { class: "master-fill" });
  const masterPeak = h("span", { class: "master-peak", text: "−∞" });
  const masterMeter = h(
    "div",
    { class: "master-meter", title: "Master peak" },
    h("span", { class: "master-label", text: "MASTER" }),
    h("div", { class: "master-track" }, masterFill),
    masterPeak,
  );

  const right = h(
    "div",
    { class: "toolbar-right" },
    h("div", { class: "right-buttons" }, undo, redo, save, h("span", { class: "toolbar-sep" }), pianoToggle, mixerToggle, audio, midi, help),
    masterMeter,
    engine,
  );

  const element = h("header", { class: "topbar" },
    h("div", { class: "toolbar-left" }, brand, menus, toolGroup, snapWrap),
    transport,
    right,
  );

  // The project location is shown as a tooltip under the document title.
  projectPath.style.display = "none";
  element.append(projectPath);

  return {
    element,
    refs: {
      projectName,
      projectPath,
      positionBars,
      positionClock,
      tempo,
      signature,
      play,
      record,
      stop,
      loop,
      metro,
      undo,
      redo,
      snap,
      save,
      tools,
      pianoToggle,
      mixerToggle,
      engineDot,
      device,
      masterFill,
      masterPeak,
      masterMeter,
    },
  };
}

function snapOptions(): Array<{ value: string; label: string }> {
  const ppq = state.project.ppq;
  return [
    { value: "0", label: "Off" },
    { value: String(Math.round(ppq * 4)), label: "1/1" },
    { value: String(Math.round(ppq * 2)), label: "1/2" },
    { value: String(ppq), label: "1/4" },
    { value: String(ppq / 2), label: "1/8" },
    { value: String(ppq / 4), label: "1/16" },
    { value: String(ppq / 8), label: "1/32" },
  ];
}

function refreshSnapOptions(): void {
  if (!refs) return;
  const select = refs.toolbar.snap;
  const value = String(state.layout.snapTicks);
  select.replaceChildren(
    ...snapOptions().map((entry) =>
      h("option", { value: entry.value, text: entry.label, selected: entry.value === value }),
    ),
  );
  if (![...select.options].some((option) => option.value === value)) {
    select.append(h("option", { value, text: "Custom", selected: true }));
  }
  select.value = value;
}

function updateProjectChrome(): void {
  if (!refs) return;
  const toolbar = refs.toolbar;
  toolbar.projectName.textContent = state.project.name;
  toolbar.projectName.title = state.projectPath ?? "Unsaved project";
  toolbar.projectPath.textContent = state.projectPath ?? "Unsaved project";
  if (document.activeElement !== toolbar.tempo) toolbar.tempo.value = String(state.project.tempo);
  toolbar.signature.textContent = `${state.project.timeSignature.numerator}/${state.project.timeSignature.denominator}`;
  toolbar.loop.classList.toggle("is-active", state.project.loopRegion.enabled);
  toolbar.metro.classList.toggle("is-active", state.project.metronome);
  toolbar.save.classList.toggle("has-changes", state.dirty);
  toolbar.save.title = state.dirty ? "Save project (unsaved changes)" : "Save project";
  refreshSnapOptions();
  updateUndoRedo();
  updateStatus();
  updateSelectionChrome();
}

function updateUndoRedo(): void {
  if (!refs) return;
  refs.toolbar.undo.disabled = !actions.canUndo();
  refs.toolbar.redo.disabled = !actions.canRedo();
}

function updateTransportChrome(): void {
  if (!refs) return;
  const transport = state.transport;
  const toolbar = refs.toolbar;
  const ticks = transport?.positionTicks ?? 0;
  toolbar.positionBars.textContent = formatBarsBeats(
    ticks,
    state.project.ppq,
    state.project.timeSignature,
  );
  toolbar.positionClock.textContent = formatClock(transport?.positionSeconds ?? ticksToSeconds(ticks));
  const playing = transport?.playing ?? false;
  const iconName = playing ? "pause" : "play";
  const existing = toolbar.play.querySelector("svg");
  if (existing) existing.replaceWith(icon(iconName, 17));
  toolbar.play.classList.toggle("is-playing", playing);
  toolbar.play.title = playing ? "Pause (Space)" : "Play (Space)";
  toolbar.record.classList.toggle("is-active", transport?.recording ?? false);
  toolbar.loop.classList.toggle("is-active", state.project.loopRegion.enabled);
  toolbar.metro.classList.toggle("is-active", state.project.metronome);
  const master = clamp((peakToDb(transport?.masterPeak ?? 0) + 60) / 60, 0, 1);
  toolbar.masterFill.style.width = `${Math.pow(master, 0.75) * 100}%`;
  toolbar.masterMeter.classList.toggle("is-hot", master > 0.96);
  const db = peakToDb(transport?.masterPeak ?? 0);
  toolbar.masterPeak.textContent = db <= -95 ? "−∞" : `${db.toFixed(1)}`;
  updateStatus();
}

function ticksToSeconds(ticks: number): number {
  return (ticks / Math.max(1, state.project.ppq)) * (60 / state.project.tempo);
}

function updateSelectionChrome(): void {
  if (!refs) return;
  const toolbar = refs.toolbar;
  for (const [tool, button] of Object.entries(toolbar.tools)) {
    button.classList.toggle("is-active", state.layout.tool === tool);
  }
  toolbar.pianoToggle.classList.toggle("is-active", state.layout.bottomTab === "piano");
  toolbar.mixerToggle.classList.toggle("is-active", state.layout.bottomTab === "mixer");
  updateStatus();
}

function updateEngineChrome(): void {
  if (!refs) return;
  const toolbar = refs.toolbar;
  const transport = state.transport;
  const ready = transport?.engineReady ?? false;
  const hasError = state.engineWarnings.length > 0 || Boolean(transport?.deviceError);
  toolbar.engineDot.classList.toggle("is-ready", ready && !hasError);
  toolbar.engineDot.classList.toggle("is-error", hasError);
  toolbar.device.textContent = ready
    ? `${transport?.outputDevice ?? "Audio output"} · ${transport?.sampleRate ?? state.project.sampleRate} Hz`
    : transport?.deviceError ?? "Audio engine unavailable";
  toolbar.device.title = transport?.deviceError ?? state.engineWarnings.join("\n") ?? "";
  updateStatus();
}

function updateUiChrome(): void {
  if (!refs) return;
  const busy = Boolean(state.busy);
  refs.busy.classList.toggle("is-visible", busy);
  refs.busyText.textContent = state.busy ?? "";
  updateStatus();
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function fileMenu(): MenuItem[] {
  return [
    { label: "New Project", shortcut: "Ctrl+N", action: () => void actions.newProject() },
    { label: "Open Project…", shortcut: "Ctrl+O", action: () => void actions.openProject() },
    { label: "Save", shortcut: "Ctrl+S", action: () => void actions.saveProject() },
    { label: "Save As…", shortcut: "Ctrl+Shift+S", action: () => void actions.saveProject(true) },
    { separator: true },
    { label: "Import Audio…", action: () => void actions.importAudioFile() },
    { label: "Import MIDI…", action: () => void actions.importMidiFile() },
    { separator: true },
    { label: "Export Audio Mixdown…", shortcut: "Ctrl+E", action: () => actions.openModal("export") },
    { label: "Export MIDI File…", action: () => void actions.exportMidi() },
    { separator: true },
    { label: "Autosave & Recovery…", action: () => actions.openModal("recovery") },
    { separator: true },
    {
      label: "Exit",
      action: async () => {
        if (state.dirty) {
          const discard = await fileDialog.confirm(
            `"${state.project.name}" has unsaved changes. Quit without saving?`,
            "Quit Studio Clone",
          );
          if (!discard) return;
        }
        await api.quitApp();
      },
    },
  ];
}

function editMenu(): MenuItem[] {
  return [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: !actions.canUndo(), action: () => actions.undo() },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", disabled: !actions.canRedo(), action: () => actions.redo() },
    { separator: true },
    {
      label: "Split at Cursor",
      disabled: !state.selection.clipId && !state.selection.partId,
      action: () => actions.splitAtPlayhead(),
    },
    {
      label: "Duplicate Selection",
      shortcut: "Ctrl+D",
      disabled: !state.selection.clipId && !state.selection.partId && state.selection.noteIds.length === 0,
      action: () => actions.duplicateSelection(),
    },
    {
      label: "Delete Selection",
      shortcut: "Del",
      disabled: !state.selection.clipId && !state.selection.partId && state.selection.noteIds.length === 0,
      action: () => actions.deleteSelection(),
    },
    { separator: true },
    {
      label: "Select All Notes",
      shortcut: "Ctrl+A",
      disabled: !state.selection.partId,
      action: () => actions.selectAllNotes(),
    },
    {
      label: "Quantize Selected Notes",
      shortcut: "Q",
      disabled: !state.selection.partId,
      action: () => {
        if (state.selection.trackId && state.selection.partId) {
          actions.quantizeNotes(state.selection.trackId, state.selection.partId);
        }
      },
    },
  ];
}

function projectMenu(): MenuItem[] {
  return [
    { label: "Project Setup…", action: () => actions.openModal("project") },
    { label: "Add Track…", action: () => actions.openModal("addTrack") },
    { separator: true },
    { label: "Audio Connections…", action: () => actions.openModal("audio") },
    { label: "MIDI Connections…", action: () => actions.openModal("midi") },
    { separator: true },
    { label: "Key Commands…", action: () => actions.openModal("shortcuts") },
    { label: "Autosave & Recovery…", action: () => actions.openModal("recovery") },
    { separator: true },
    { label: "About Studio Clone…", action: () => actions.openModal("about") },
  ];
}

function settingsMenu(): MenuItem[] {
  const ppq = state.project.ppq;
  const snapItems: MenuItem[] = [
    { label: "Off", checked: state.layout.snapTicks === 0, action: () => actions.setSnap(0) },
    { label: "1/4", checked: state.layout.snapTicks === ppq, action: () => actions.setSnap(ppq) },
    { label: "1/8", checked: state.layout.snapTicks === ppq / 2, action: () => actions.setSnap(ppq / 2) },
    { label: "1/16", checked: state.layout.snapTicks === ppq / 4, action: () => actions.setSnap(ppq / 4) },
    { label: "1/32", checked: state.layout.snapTicks === ppq / 8, action: () => actions.setSnap(ppq / 8) },
    { label: "1/16 Triplet", checked: state.layout.snapTicks === ppq / 6, action: () => actions.setSnap(ppq / 6) },
  ];
  const colors: MenuItem[] = [
    { label: "Blue", checked: state.layout.trackColor === "#4f8fce", action: () => actions.setDefaultTrackColor("#4f8fce") },
    { label: "Green", checked: state.layout.trackColor === "#67c07a", action: () => actions.setDefaultTrackColor("#67c07a") },
    { label: "Gold", checked: state.layout.trackColor === "#c9a227", action: () => actions.setDefaultTrackColor("#c9a227") },
    { label: "Orange", checked: state.layout.trackColor === "#c97a4f", action: () => actions.setDefaultTrackColor("#c97a4f") },
    { label: "Purple", checked: state.layout.trackColor === "#a56fce", action: () => actions.setDefaultTrackColor("#a56fce") },
    { label: "Teal", checked: state.layout.trackColor === "#4fc0b7", action: () => actions.setDefaultTrackColor("#4fc0b7") },
    { label: "Pink", checked: state.layout.trackColor === "#ce4f7a", action: () => actions.setDefaultTrackColor("#ce4f7a") },
    { label: "Olive", checked: state.layout.trackColor === "#8a9a5b", action: () => actions.setDefaultTrackColor("#8a9a5b") },
  ];
  return [
    { label: "Snap Grid", disabled: true },
    ...snapItems,
    { separator: true },
    { label: "Default Track Color", disabled: true },
    ...colors,
  ];
}

// ---------------------------------------------------------------------------
// Layout / resizers
// ---------------------------------------------------------------------------

function applyLayout(): void {
  if (!refs) return;
  refs.leftPanel.style.width = `${state.layout.leftWidth}px`;
  refs.root.style.setProperty("--left-width", `${state.layout.leftWidth}px`);
  refs.root.style.setProperty("--bottom-height", `${state.layout.bottomHeight}px`);
  const collapsed = state.layout.bottomTab === "none";
  refs.bottomPanel.classList.toggle("is-collapsed", collapsed);
  refs.bottomResizer.classList.toggle("is-hidden", collapsed);
  refs.inspectorHost.classList.toggle("is-hidden", state.layout.leftTab !== "inspector");
  refs.mediaHost.classList.toggle("is-hidden", state.layout.leftTab !== "media");
  refs.pianoHost.classList.toggle("is-hidden", state.layout.bottomTab !== "piano");
  refs.mixerHost.classList.toggle("is-hidden", state.layout.bottomTab !== "mixer");
  refs.leftTabs.forEach((button, index) => {
    button.classList.toggle("is-active", (index === 0 ? "inspector" : "media") === state.layout.leftTab);
  });
  refs.bottomTabs.forEach((button, index) => {
    button.classList.toggle("is-active", (index === 0 ? "piano" : "mixer") === state.layout.bottomTab);
  });
  refreshSnapOptions();
  updateSelectionChrome();
}

function wireResizers(): void {
  if (!refs) return;
  wireDrag(refs.leftResizer, "x", (event) => {
    const width = clamp(window.innerWidth - event.clientX - 24, 228, 480);
    actions.setLayout({ leftWidth: width });
  }, () => actions.setLayout({ leftWidth: 286 }));
  wireDrag(refs.bottomResizer, "y", (event) => {
    if (!refs) return;
    const rect = refs.bottomPanel.getBoundingClientRect();
    const minHeight = state.layout.bottomTab === "mixer" ? MIXER_MIN_BOTTOM_HEIGHT : MIN_BOTTOM_HEIGHT;
    const height = clamp(rect.bottom - event.clientY, minHeight, Math.min(620, window.innerHeight * 0.62));
    actions.setLayout({ bottomHeight: height });
  }, () => actions.setLayout({ bottomHeight: DEFAULT_BOTTOM_HEIGHT }));
}

function wireDrag(
  element: HTMLElement,
  _axis: "x" | "y",
  onMove: (event: PointerEvent) => void,
  onDoubleClick: () => void,
): void {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent): void => onMove(moveEvent);
    const end = (endEvent: PointerEvent): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      if (element.hasPointerCapture(endEvent.pointerId)) element.releasePointerCapture(endEvent.pointerId);
      element.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  });
  element.addEventListener("dblclick", onDoubleClick);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function buildStatusBar(): { element: HTMLElement; refs: StatusRefs } {
  const path = h("span", { class: "status-path", text: "Unsaved project" });
  const dirty = h("span", { class: "status-dirty", text: "" });
  const selection = h("span", { class: "status-selection", text: "No selection" });
  const engine = h("span", { class: "status-engine", text: "Engine" });
  const device = h("span", { class: "status-item", text: "—" });
  const tempo = h("span", { class: "status-item", text: "120 BPM" });
  const tracks = h("span", { class: "status-item", text: "0 tracks" });
  const savings = h("span", { class: "status-item", text: "Autosave ready" });
  const position = h("span", { class: "status-item status-position", text: "1.1.1" });
  const element = h(
    "footer",
    { class: "statusbar" },
    h("div", { class: "status-left" }, path, dirty),
    h("div", { class: "status-center" }, selection),
    h(
      "div",
      { class: "status-right" },
      engine,
      device,
      h("span", { class: "status-sep" }),
      tempo,
      tracks,
      h("span", { class: "status-sep" }),
      savings,
      position,
    ),
  );
  return {
    element,
    refs: { path, dirty, selection, engine, device, tempo, tracks, savings, position },
  };
}

function updateStatus(): void {
  if (!refs) return;
  const status = refs.status;
  const transport = state.transport;
  status.path.textContent = state.projectPath ?? "Unsaved project";
  status.path.title = state.projectPath ?? "This project has not been saved yet.";
  status.dirty.textContent = state.dirty ? "● modified" : "saved";
  status.dirty.classList.toggle("is-dirty", state.dirty);

  const track = actions.selectedTrack();
  if (track) {
    let detail = track.name;
    if (state.selection.clipId) {
      detail += ` · ${track.clips.find((clip) => clip.id === state.selection.clipId)?.name ?? "Audio clip"}`;
    } else if (state.selection.partId) {
      const part = track.parts.find((entry) => entry.id === state.selection.partId);
      detail += ` · ${part?.name ?? "MIDI part"}${
        state.selection.noteIds.length ? ` · ${state.selection.noteIds.length} notes` : ""
      }`;
    }
    status.selection.textContent = detail;
  } else {
    status.selection.textContent = "Project";
  }

  const ready = transport?.engineReady ?? false;
  status.engine.textContent = ready ? "Engine ready" : "Engine offline";
  status.engine.classList.toggle("is-ready", ready);
  status.engine.classList.toggle("is-error", !ready && Boolean(transport?.deviceError));
  status.device.textContent = transport
    ? `${transport.sampleRate} Hz`
    : `${state.project.sampleRate} Hz`;
  status.device.title = transport?.outputDevice ?? "";
  status.tempo.textContent = `${state.project.tempo.toFixed(1)} BPM`;
  status.tracks.textContent = `${state.project.tracks.length} tracks`;
  const last = state.lastAutosaveAt;
  status.savings.textContent = state.dirty
    ? last
      ? `Autosaved ${new Date(last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Unsaved changes"
    : state.savedAt
      ? `Saved ${new Date(state.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "No changes";
  status.position.textContent = `${formatBarsBeats(
    transport?.positionTicks ?? 0,
    state.project.ppq,
    state.project.timeSignature,
  )} · ${track ? "" : `${Math.ceil(projectEndTicks(state.project) / state.project.ppq)} beats`}`;
  status.position.title = `${projectEndTicks(state.project)} ticks project length`;
}

// ---------------------------------------------------------------------------
// Toasts and busy state
// ---------------------------------------------------------------------------

function renderToasts(): void {
  if (!refs) return;
  refs.toastHost.replaceChildren(
    ...state.toasts.map((toast) =>
      h(
        "div",
        { class: `toast toast-${toast.kind}`, role: "status" },
        icon(
          toast.kind === "error" ? "warning" : toast.kind === "success" ? "check" : "sparkle",
          14,
        ),
        h("span", { class: "toast-text", text: toast.text }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Keyboard and close handling
// ---------------------------------------------------------------------------

function wireKeyboard(): void {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.key === "Escape") {
      if (state.modal) {
        event.preventDefault();
        actions.closeModal();
        return;
      }
      if (isEditableTarget(target)) return;
      actions.clearSelection();
      return;
    }
    if (state.modal) return;
    if (isEditableTarget(target)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const interactive =
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target instanceof HTMLSelectElement;

    if (ctrl) {
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void actions.saveProject(event.shiftKey);
        return;
      }
      if (key === "o") {
        event.preventDefault();
        void actions.openProject();
        return;
      }
      if (key === "n") {
        event.preventDefault();
        void actions.newProject();
        return;
      }
      if (key === "e") {
        event.preventDefault();
        actions.openModal("export");
        return;
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) actions.redo();
        else actions.undo();
        return;
      }
      if (key === "y") {
        event.preventDefault();
        actions.redo();
        return;
      }
      if (key === "d") {
        event.preventDefault();
        actions.duplicateSelection();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        actions.selectAllNotes();
        return;
      }
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        actions.zoomIn();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        actions.zoomOut();
        return;
      }
    }

    if (event.key === " " && !interactive) {
      event.preventDefault();
      void actions.transportToggle();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      void actions.seekTicks(0);
      return;
    }
    if (event.key === "F12") {
      event.preventDefault();
      void actions.transportStop();
      return;
    }
    if (event.key === "Tab" && !interactive) {
      event.preventDefault();
      const next = state.layout.bottomTab === "piano" ? "mixer" : "piano";
      actions.setBottomTab(next);
      if (next === "piano") refreshPiano();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      actions.deleteSelection();
      return;
    }
    if (event.key === "1") {
      actions.setTool("select");
      return;
    }
    if (event.key === "2") {
      actions.setTool("draw");
      return;
    }
    if (event.key === "3") {
      actions.setTool("split");
      return;
    }
    if (event.key.toLowerCase() === "l") {
      actions.toggleLoop();
      return;
    }
    if (event.key.toLowerCase() === "m") {
      actions.toggleMetronome();
      return;
    }
    if (event.key.toLowerCase() === "q") {
      if (state.selection.trackId && state.selection.partId) {
        actions.quantizeNotes(state.selection.trackId, state.selection.partId);
      }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const ticks = state.transport?.positionTicks ?? 0;
      const step = event.shiftKey
        ? state.project.ppq * state.project.timeSignature.numerator
        : state.layout.snapTicks || state.project.ppq / 4;
      event.preventDefault();
      void actions.seekTicks(Math.max(0, ticks + (event.key === "ArrowRight" ? step : -step)));
    }
  });
}

function wireCloseGuard(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    // Browser preview fallback. Inside Tauri the beforeunload handler also
    // cancels the Window.destroy() call made after the close confirmation,
    // leaving the app impossible to close.
    window.addEventListener("beforeunload", (event) => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
    return;
  }
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.onCloseRequested(async (event) => {
        if (!state.dirty) return;
        const discard = await fileDialog.confirm(
          `"${state.project.name}" has unsaved changes. Quit without saving?`,
          "Quit Studio Clone",
        );
        if (!discard) event.preventDefault();
      });
    } catch {
      // Running outside the Tauri shell (for example Vite preview).
    }
  })();
}

export function updateWindowChrome(): void {
  updateProjectChrome();
}
