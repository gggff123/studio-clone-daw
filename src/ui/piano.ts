import * as actions from "../actions";
import { state, store } from "../store";
import type { MidiNote, MidiPart, Track } from "../types";
import { h } from "../utils/dom";
import {
  barTicks,
  beatTicks,
  clamp,
  isBlackKey,
  noteName,
  ticksToPx,
} from "../utils/format";
import { iconButton, selectBox } from "./controls";
import { openContextMenu } from "./menu";
import { icon } from "./icons";

interface NoteDrag {
  noteId: string;
  mode: "move" | "resize-left" | "resize-right";
  startX: number;
  startY: number;
  originals: Map<string, { startTicks: number; durationTicks: number; pitch: number }>;
  element: HTMLElement;
  moved: boolean;
}

let host: HTMLElement;
let toolbar: HTMLElement;
let main: HTMLElement;
let gridScroll: HTMLElement;
let gridEl: HTMLElement;
let rulerView: HTMLElement;
let rulerInner: HTMLElement;
let keysView: HTMLElement;
let keysInner: HTMLElement;
let velView: HTMLElement;
let velInner: HTMLElement;
let gridPlayhead: HTMLElement;
let rulerPlayhead: HTMLElement;
let velPlayhead: HTMLElement;

let renderedTrackId: string | null = null;
let renderedPartId: string | null = null;
let noteElements = new Map<string, HTMLElement>();
let drag: NoteDrag | null = null;
let contentWidth = 800;
let contentTicks = 0;
let lastPianoZoom = state.layout.pianoZoom;

function ppq(): number {
  return state.project.ppq;
}

function keyHeight(): number {
  return state.layout.pianoZoom;
}

function pxPerTick(): number {
  return state.layout.arrangeZoom / Math.max(1, ppq());
}

function currentPart(): { track: Track; part: MidiPart } | null {
  const track = state.project.tracks.find((entry) => entry.id === state.selection.trackId);
  if (!track) return null;
  const part = track.parts.find((entry) => entry.id === state.selection.partId);
  return part ? { track, part } : null;
}

function gridWidth(): number {
  return Math.max(standardWidth(), ticksToPx(contentTicks, state.layout.arrangeZoom, ppq()));
}

function standardWidth(): number {
  const view = gridScroll ? gridScroll.clientWidth : 800;
  return Math.max(600, view - 1);
}

export function mountPiano(hostElement: HTMLElement): void {
  host = hostElement;
  host.classList.add("piano-panel");

  toolbar = h("div", { class: "piano-toolbar panel-toolbar" });
  main = h("div", { class: "piano-main" });

  rulerView = h("div", { class: "piano-ruler-view" });
  rulerInner = h("div", { class: "piano-ruler-inner" });
  rulerView.append(rulerInner);
  keysView = h("div", { class: "piano-keys-view" });
  keysInner = h("div", { class: "piano-keys-inner" });
  keysView.append(keysInner);
  gridScroll = h("div", { class: "piano-grid-scroll" });
  gridEl = h("div", { class: "piano-grid" });
  gridScroll.append(gridEl);
  velView = h("div", { class: "piano-vel-view" });
  velInner = h("div", { class: "piano-vel-inner" });
  velView.append(velInner);

  gridPlayhead = h("div", { class: "piano-playhead" });
  rulerPlayhead = h("div", { class: "piano-ruler-playhead" });
  velPlayhead = h("div", { class: "piano-vel-playhead" });

  main.append(
    h("div", { class: "piano-corner" }),
    rulerView,
    keysView,
    gridScroll,
    h("div", { class: "piano-vel-label", text: "Velocity" }),
    velView,
  );
  host.append(toolbar, main);

  gridScroll.addEventListener("scroll", syncScroll, { passive: true });
  gridScroll.addEventListener("pointerdown", onGridPointerDown);
  gridScroll.addEventListener("wheel", onWheel, { passive: false });

  store.on("project", () => render());
  store.on("layout", () => {
    if (state.layout.pianoZoom !== lastPianoZoom) {
      lastPianoZoom = state.layout.pianoZoom;
      render();
    }
  });
  store.on("selection", () => {
    const part = currentPart();
    if (!part) {
      render();
      return;
    }
    if (part.track.id !== renderedTrackId || part.part.id !== renderedPartId) {
      render();
      return;
    }
    applyNoteSelection();
  });
  store.on("transport", updatePlayhead);
  render();
}

function render(): void {
  if (!host) return;
  const partInfo = currentPart();
  if (!partInfo) {
    renderToolbar(null);
    renderEmpty();
    renderedTrackId = null;
    renderedPartId = null;
    return;
  }
  const { track, part } = partInfo;
  const partChanged = renderedTrackId !== track.id || renderedPartId !== part.id;
  const previousLeft = gridScroll.scrollLeft;
  const previousTop = gridScroll.scrollTop;
  renderToolbar(partInfo);
  renderGrid(track, part);
  renderKeys(track);
  renderRuler(part);
  renderVelocity(track, part);
  renderedTrackId = track.id;
  renderedPartId = part.id;
  applyNoteSelection();
  if (partChanged) {
    const pitches = part.notes.map((note) => note.pitch);
    const centerPitch = pitches.length
      ? pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length
      : 60;
    gridScroll.scrollTop = Math.max(0, (127 - centerPitch) * keyHeight() - gridScroll.clientHeight / 2);
    gridScroll.scrollLeft = 0;
  } else {
    gridScroll.scrollLeft = previousLeft;
    gridScroll.scrollTop = previousTop;
  }
  syncScroll();
  updatePlayhead();
}

function renderToolbar(partInfo: { track: Track; part: MidiPart } | null): void {
  toolbar.replaceChildren();
  if (!partInfo) {
    toolbar.style.display = "none";
    return;
  }
  toolbar.style.display = "";
  const { track, part } = partInfo;
  const snapOptions = [
    { value: "3840", label: "Snap 1/1" },
    { value: "1920", label: "Snap 1/2" },
    { value: "960", label: "Snap 1/4" },
    { value: "480", label: "Snap 1/8" },
    { value: "240", label: "Snap 1/16" },
    { value: "120", label: "Snap 1/32" },
    { value: "0", label: "Snap Off" },
  ];
  const zoom = h("div", { class: "piano-zoom" },
    iconButton("zoomOut", () => actions.setPianoZoom(keyHeight() - 2), { title: "Smaller keys", size: 13 }),
    iconButton("zoomIn", () => actions.setPianoZoom(keyHeight() + 2), { title: "Taller keys", size: 13 }),
  );

  toolbar.append(
    h(
      "span",
      { class: "piano-title" },
      icon("keyboard", 14),
      h("span", { class: "piano-part-name", text: part.name }),
      h("span", { class: "piano-track-name", text: track.name }),
    ),
    h("div", { class: "toolbar-sep" }),
    selectBox(snapOptions, String(state.layout.snapTicks), (value) =>
      actions.setSnap(Number(value)),
      "snap-select",
    ),
    h(
      "button",
      {
        class: "text-btn",
        type: "button",
        title: "Quantize selected notes (Q)",
        onClick: () => actions.quantizeNotes(track.id, part.id),
      },
      "Quantize",
    ),
    h(
      "button",
      {
        class: "text-btn",
        type: "button",
        title: "Transpose selected notes down one octave",
        onClick: () => actions.transposeNotes(track.id, part.id, -12),
      },
      "−12",
    ),
    h(
      "button",
      {
        class: "text-btn",
        type: "button",
        title: "Transpose selected notes up one octave",
        onClick: () => actions.transposeNotes(track.id, part.id, 12),
      },
      "+12",
    ),
    h("span", { class: "piano-note-count", text: `${part.notes.length} notes` }),
    h("div", { class: "toolbar-spacer" }),
    zoom,
  );
}

function renderEmpty(): void {
  main.style.display = "none";
  let empty = host.querySelector<HTMLElement>(".piano-empty");
  if (!empty) {
    empty = h("div", { class: "piano-empty" });
    host.append(empty);
  }
  empty.replaceChildren();
  empty.style.display = "";
  const track = state.project.tracks.find((entry) => entry.id === state.selection.trackId);
  const parts = track?.parts ?? [];
  empty.append(
    h("div", { class: "empty-title", text: "No part selected" }),
    h(
      "div",
      { class: "empty-detail", text: "Double-click a MIDI part in the arrangement, or choose a part below." },
    ),
  );
  if (parts.length > 0 && track) {
    const list = h("div", { class: "part-choice-list" });
    for (const part of parts) {
      list.append(
        h(
          "button",
          {
            class: "part-choice",
            type: "button",
            onClick: () => actions.selectPart(track.id, part.id),
          },
          h("span", { class: "part-choice-dot", style: { background: part.color } }),
          h("span", { text: part.name }),
          h("span", { class: "part-choice-count", text: `${part.notes.length} notes` }),
        ),
      );
    }
    empty.append(list);
  } else if (track && (track.kind === "instrument" || track.kind === "midi")) {
    empty.append(
      h(
        "button",
        {
          class: "text-btn primary",
          type: "button",
          onClick: () => {
            const part = actions.addMidiPart(track.id, state.transport?.positionTicks ?? 0);
            if (part) actions.selectPart(track.id, part.id);
          },
        },
        "Create MIDI Part",
      ),
    );
  }
}

function renderGrid(track: Track, part: MidiPart): void {
  main.style.display = "";
  gridScroll.style.display = "";
  keysView.style.display = "";
  rulerView.style.display = "";
  velView.style.display = "";
  const empty = host.querySelector<HTMLElement>(".piano-empty");
  if (empty) empty.style.display = "none";

  const keyH = keyHeight();
  let maxNote = part.durationTicks;
  for (const note of part.notes) {
    maxNote = Math.max(maxNote, note.startTicks + note.durationTicks);
  }
  contentTicks = Math.max(maxNote + barTicks(ppq(), state.project.timeSignature), part.durationTicks);
  contentWidth = gridWidth();
  const height = 128 * keyH;

  gridEl.replaceChildren();
  gridEl.style.width = `${contentWidth}px`;
  gridEl.style.height = `${height}px`;
  gridEl.style.setProperty("--key-height", `${keyH}px`);
  gridEl.style.setProperty("--beat-width", `${ticksToPx(beatTicks(ppq(), state.project.timeSignature), state.layout.arrangeZoom, ppq())}px`);
  gridEl.style.setProperty("--bar-width", `${ticksToPx(barTicks(ppq(), state.project.timeSignature), state.layout.arrangeZoom, ppq())}px`);

  for (let pitch = 0; pitch < 128; pitch += 1) {
    const row = h("div", {
      class: `pitch-row ${isBlackKey(pitch) ? "is-black" : ""}`,
      style: { top: `${(127 - pitch) * keyH}px`, height: `${keyH}px` },
      dataset: { pitch: String(pitch) },
    });
    gridEl.append(row);
  }

  const bar = barTicks(ppq(), state.project.timeSignature);
  const totalBars = Math.ceil(contentTicks / bar) + 1;
  for (let index = 0; index < totalBars; index += 1) {
    const left = ticksToPx(index * bar, state.layout.arrangeZoom, ppq());
    gridEl.append(
      h("div", {
        class: "piano-bar-line",
        style: { left: `${left}px` },
      }),
    );
    if (ticksToPx(beatTicks(ppq(), state.project.timeSignature), state.layout.arrangeZoom, ppq()) > 12) {
      for (let beat = 1; beat < state.project.timeSignature.numerator; beat += 1) {
        gridEl.append(
          h("div", {
            class: "piano-beat-line",
            style: {
              left: `${left + ticksToPx(beat * beatTicks(ppq(), state.project.timeSignature), state.layout.arrangeZoom, ppq())}px`,
            },
          }),
        );
      }
    }
  }

  gridEl.append(
    h("div", {
      class: "part-boundary",
      style: { left: `${ticksToPx(part.durationTicks, state.layout.arrangeZoom, ppq())}px` },
      title: "Part end",
    }),
  );

  noteElements = new Map();
  for (const note of part.notes) {
    const element = buildNote(track, part, note, keyH);
    noteElements.set(note.id, element);
    gridEl.append(element);
  }

  gridEl.append(gridPlayhead);
  void track;
}

function buildNote(track: Track, part: MidiPart, note: MidiNote, keyH: number): HTMLElement {
  const x = ticksToPx(note.startTicks, state.layout.arrangeZoom, ppq());
  const width = Math.max(3, ticksToPx(note.durationTicks, state.layout.arrangeZoom, ppq()));
  const element = h(
    "div",
    {
      class: `piano-note ${state.selection.noteIds.includes(note.id) ? "is-selected" : ""}`,
      style: {
        left: `${x}px`,
        top: `${(127 - note.pitch) * keyH + 1}px`,
        width: `${width}px`,
        height: `${Math.max(3, keyH - 2)}px`,
        "--note-color": track.color,
        opacity: String(0.42 + (note.velocity / 127) * 0.58),
      } as Partial<CSSStyleDeclaration>,
      dataset: { noteId: note.id },
      title: `${noteName(note.pitch)} · velocity ${note.velocity} · ${(note.durationTicks / ppq()).toFixed(2)} beats`,
    },
    h("span", { class: "note-label", text: noteName(note.pitch) }),
    h("span", { class: "note-handle left", dataset: { noteEdge: "left" } }),
    h("span", { class: "note-handle right", dataset: { noteEdge: "right" } }),
  );

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const noteId = note.id;
    const already = state.selection.noteIds.includes(noteId);
    if (event.shiftKey) {
      const next = already
        ? state.selection.noteIds.filter((id) => id !== noteId)
        : [...state.selection.noteIds, noteId];
      actions.selectNotes(next);
    } else if (!already) {
      actions.selectNotes([noteId]);
    }
    void actions.audition(track.id, note.pitch, note.velocity);

    const edge = (event.target as HTMLElement).dataset.noteEdge;
    const mode: NoteDrag["mode"] =
      edge === "left" ? "resize-left" : edge === "right" ? "resize-right" : "move";
    const selectedIds = state.selection.noteIds.length ? state.selection.noteIds : [noteId];
    const originals = new Map<string, { startTicks: number; durationTicks: number; pitch: number }>();
    for (const entry of part.notes) {
      if (selectedIds.includes(entry.id)) {
        originals.set(entry.id, {
          startTicks: entry.startTicks,
          durationTicks: entry.durationTicks,
          pitch: entry.pitch,
        });
      }
    }
    if (!originals.has(noteId)) {
      originals.set(noteId, {
        startTicks: note.startTicks,
        durationTicks: note.durationTicks,
        pitch: note.pitch,
      });
    }
    drag = {
      noteId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originals,
      element,
      moved: false,
    };
    actions.beginGesture();
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      if (!drag) return;
      const deltaTicks = (moveEvent.clientX - drag.startX) / Math.max(0.0001, pxPerTick());
      const deltaPitch = Math.round((drag.startY - moveEvent.clientY) / keyH);
      if (Math.abs(deltaTicks) < 0.2 && deltaPitch === 0) return;
      drag.moved = true;
      const grid = moveEvent.altKey ? 0 : state.layout.snapTicks;
      const snap = (value: number): number =>
        grid > 0 ? Math.round(value / grid) * grid : Math.round(value);

      for (const [id, original] of drag.originals) {
        const entry = part.notes.find((item) => item.id === id);
        if (!entry) continue;
        if (drag.mode === "move") {
          const nextStart = Math.max(0, snap(original.startTicks + deltaTicks));
          const nextPitch = clamp(original.pitch + deltaPitch, 0, 127);
          actions.updateNote(track.id, part.id, id, { startTicks: nextStart, pitch: nextPitch }, true);
          const el = noteElements.get(id);
          if (el) {
            el.style.left = `${ticksToPx(nextStart, state.layout.arrangeZoom, ppq())}px`;
            el.style.top = `${(127 - nextPitch) * keyH + 1}px`;
          }
        } else if (id === drag.noteId) {
          const originalEnd = original.startTicks + original.durationTicks;
          if (drag.mode === "resize-right") {
            const duration = Math.max(1, snap(original.durationTicks + deltaTicks));
            actions.updateNote(track.id, part.id, id, { durationTicks: duration }, true);
            const el = noteElements.get(id);
            if (el) el.style.width = `${Math.max(3, ticksToPx(duration, state.layout.arrangeZoom, ppq()))}px`;
          } else {
            const start = Math.max(0, Math.min(originalEnd - 1, snap(original.startTicks + deltaTicks)));
            const duration = Math.max(1, originalEnd - start);
            actions.updateNote(track.id, part.id, id, { startTicks: start, durationTicks: duration }, true);
            const el = noteElements.get(id);
            if (el) {
              el.style.left = `${ticksToPx(start, state.layout.arrangeZoom, ppq())}px`;
              el.style.width = `${Math.max(3, ticksToPx(duration, state.layout.arrangeZoom, ppq()))}px`;
            }
          }
        }
      }
      updateVelocityBars(part);
    };

    const end = (endEvent: PointerEvent): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      if (element.hasPointerCapture(endEvent.pointerId)) element.releasePointerCapture(endEvent.pointerId);
      const moved = drag?.moved ?? false;
      drag = null;
      if (moved) actions.endGesture("project");
      else actions.cancelGesture();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  });

  element.addEventListener("contextmenu", (event) => {
    event.stopPropagation();
    if (!state.selection.noteIds.includes(note.id)) actions.selectNotes([note.id]);
    openContextMenu(event, [
      { label: "Duplicate", shortcut: "Ctrl+D", action: () => actions.duplicateSelection() },
      {
        label: "Quantize Selected",
        shortcut: "Q",
        action: () => actions.quantizeNotes(track.id, part.id),
      },
      { separator: true },
      {
        label: "Delete",
        danger: true,
        shortcut: "Del",
        action: () => actions.deleteNotes(track.id, part.id, state.selection.noteIds),
      },
    ]);
  });

  return element;
}

function onGridPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest(".piano-note")) return;
  const partInfo = currentPart();
  if (!partInfo) return;
  const rect = gridEl.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const pitch = clamp(127 - Math.floor(localY / keyHeight()), 0, 127);
  const rawTick = (localX / Math.max(0.0001, pxPerTick()));
  const grid = event.altKey ? 0 : state.layout.snapTicks;
  const tick = grid > 0 ? Math.max(0, Math.round(rawTick / grid) * grid) : Math.max(0, Math.round(rawTick));

  if (state.layout.tool === "draw" || event.detail >= 2) {
    const duration = Math.max(1, grid || ppq() / 4);
    const note = actions.addNote(partInfo.track.id, partInfo.part.id, {
      pitch,
      startTicks: tick,
      durationTicks: duration,
      velocity: 100,
      channel: 0,
    });
    if (note) void actions.audition(partInfo.track.id, pitch, 100);
  } else {
    actions.selectNotes([]);
    const absolute = partInfo.part.startTicks + tick;
    void actions.seekTicks(absolute);
  }
}

function onWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    actions.setPianoZoom(keyHeight() + (event.deltaY > 0 ? -1 : 1));
  }
}

function renderKeys(track: Track): void {
  const keyH = keyHeight();
  keysInner.replaceChildren();
  keysInner.style.height = `${128 * keyH}px`;
  for (let pitch = 127; pitch >= 0; pitch -= 1) {
    const black = isBlackKey(pitch);
    const label = pitch % 12 === 0 ? noteName(pitch) : "";
    const key = h(
      "div",
      {
        class: `piano-key ${black ? "is-black" : "is-white"}`,
        style: { height: `${keyH}px` },
        dataset: { pitch: String(pitch) },
        title: noteName(pitch),
      },
      label ? h("span", { class: "key-name", text: label }) : null,
    );
    key.addEventListener("pointerdown", () => {
      void actions.audition(track.id, pitch, 100);
    });
    keysInner.append(key);
  }
}

function renderRuler(part: MidiPart): void {
  rulerInner.replaceChildren();
  rulerInner.style.width = `${contentWidth}px`;
  rulerInner.style.height = "24px";
  const bar = barTicks(ppq(), state.project.timeSignature);
  const startBar = Math.floor(part.startTicks / bar);
  const totalBars = Math.ceil((part.startTicks + contentTicks) / bar) + 1;
  for (let index = startBar; index <= totalBars; index += 1) {
    const localTick = index * bar - part.startTicks;
    if (localTick < -bar) continue;
    const left = ticksToPx(localTick, state.layout.arrangeZoom, ppq());
    rulerInner.append(
      h("div", { class: "piano-ruler-tick", style: { left: `${left}px` } }),
      h("div", {
        class: "piano-ruler-label",
        text: String(index + 1),
        style: { left: `${Math.max(2, left + 4)}px` },
      }),
    );
  }
  for (const marker of state.project.markers) {
    const local = marker.ticks - part.startTicks;
    if (local < 0 || local > contentTicks) continue;
    rulerInner.append(
      h("div", {
        class: "piano-marker",
        style: { left: `${ticksToPx(local, state.layout.arrangeZoom, ppq())}px`, background: marker.color },
        title: marker.name,
      }),
    );
  }
  rulerInner.append(rulerPlayhead);
}

function renderVelocity(track: Track, part: MidiPart): void {
  velInner.replaceChildren();
  velInner.style.width = `${contentWidth}px`;
  for (const note of part.notes) {
    const bar = h("div", {
      class: `vel-bar ${state.selection.noteIds.includes(note.id) ? "is-selected" : ""}`,
      style: {
        left: `${ticksToPx(note.startTicks, state.layout.arrangeZoom, ppq())}px`,
        height: `${Math.max(2, (note.velocity / 127) * 54)}px`,
      },
      dataset: { noteId: note.id },
      title: `Velocity ${note.velocity}`,
    });
    bar.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      const noteId = note.id;
      if (!state.selection.noteIds.includes(noteId)) actions.selectNotes([noteId]);
      const barRect = velInner.getBoundingClientRect();
      actions.beginGesture();
      bar.setPointerCapture(event.pointerId);
      let moved = false;
      const move = (moveEvent: PointerEvent): void => {
        moved = true;
        const relative = clamp(1 - (moveEvent.clientY - barRect.top) / Math.max(1, barRect.height), 0, 1);
        const value = Math.max(1, Math.round(relative * 127));
        const ids = state.selection.noteIds.filter((id) =>
          part.notes.some((item) => item.id === id),
        );
        actions.setNoteVelocity(track.id, part.id, ids.length ? ids : [noteId], value, true);
        for (const id of ids.length ? ids : [noteId]) {
          const el = velInner.querySelector<HTMLElement>(`[data-note-id="${id}"]`);
          if (el) el.style.height = `${Math.max(2, (value / 127) * 54)}px`;
          const noteEl = noteElements.get(id);
          if (noteEl) noteEl.style.opacity = String(0.42 + (value / 127) * 0.58);
        }
      };
      const end = (endEvent: PointerEvent): void => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", end);
        bar.removeEventListener("pointercancel", end);
        if (bar.hasPointerCapture(endEvent.pointerId)) bar.releasePointerCapture(endEvent.pointerId);
        if (moved) actions.endGesture("project");
        else actions.cancelGesture();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
    });
    velInner.append(bar);
  }
  velInner.append(velPlayhead);
}

function updateVelocityBars(part: MidiPart): void {
  for (const bar of velInner.querySelectorAll<HTMLElement>(".vel-bar")) {
    const note = part.notes.find((entry) => entry.id === bar.dataset.noteId);
    if (!note) continue;
    bar.style.height = `${Math.max(2, (note.velocity / 127) * 54)}px`;
  }
  for (const note of part.notes) {
    const bar = velInner.querySelector<HTMLElement>(`[data-note-id="${note.id}"]`);
    if (bar) bar.style.left = `${ticksToPx(note.startTicks, state.layout.arrangeZoom, ppq())}px`;
  }
}

function applyNoteSelection(): void {
  const ids = new Set(state.selection.noteIds);
  for (const [id, element] of noteElements) {
    element.classList.toggle("is-selected", ids.has(id));
  }
  for (const bar of velInner.querySelectorAll<HTMLElement>(".vel-bar")) {
    bar.classList.toggle("is-selected", ids.has(bar.dataset.noteId ?? ""));
  }
}

function updatePlayhead(): void {
  const partInfo = currentPart();
  const transport = state.transport;
  if (!partInfo || !transport) return;
  const local = transport.positionTicks - partInfo.part.startTicks;
  const x = ticksToPx(local, state.layout.arrangeZoom, ppq());
  const visible = local >= 0 && local <= partInfo.part.durationTicks;
  for (const element of [gridPlayhead, rulerPlayhead, velPlayhead]) {
    element.style.left = `${x}px`;
    element.style.display = visible ? "" : "none";
  }
  if (visible && transport.playing) {
    const viewLeft = gridScroll.scrollLeft;
    const viewRight = viewLeft + gridScroll.clientWidth;
    if (x < viewLeft + 10 || x > viewRight - 40) {
      gridScroll.scrollLeft = Math.max(0, x - gridScroll.clientWidth * 0.25);
    }
  }
}

function syncScroll(): void {
  const left = gridScroll.scrollLeft;
  const top = gridScroll.scrollTop;
  rulerInner.style.transform = `translateX(${-left}px)`;
  velInner.style.transform = `translateX(${-left}px)`;
  keysInner.style.transform = `translateY(${-top}px)`;
}

export function refreshPiano(): void {
  render();
  window.requestAnimationFrame(() => {
    syncScroll();
    updatePlayhead();
  });
}
