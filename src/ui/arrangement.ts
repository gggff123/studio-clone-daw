import * as actions from "../actions";
import { state, store } from "../store";
import type { AudioClip, MidiPart, Track } from "../types";
import { h } from "../utils/dom";
import {
  barTicks,
  beatTicks,
  clamp,
  formatBarsBeats,
  formatDb,
  noteName,
  projectLengthBars,
  ticksToPx,
  uuid,
} from "../utils/format";
import { api } from "../api";
import { iconButton, inlineRename, rangeControl } from "./controls";
import { openContextMenu } from "./menu";
import { icon } from "./icons";

type DragKind = "move" | "resize-left" | "resize-right";

interface ItemDrag {
  kind: DragKind;
  type: "clip" | "part";
  trackId: string;
  itemId: string;
  element: HTMLElement;
  startX: number;
  startTicks: number;
  durationTicks: number;
  offsetTicks: number;
  moved: boolean;
  partStart?: number;
}

interface LoopDrag {
  mode: "new" | "body" | "start" | "end";
  anchorTicks: number;
  originalStart: number;
  originalEnd: number;
  moved: boolean;
}

let hostEl: HTMLElement | null = null;
let rulerEl: HTMLElement;
let rulerInner: HTMLElement;
let headersEl: HTMLElement;
let headersInner: HTMLElement;
let laneScroll: HTMLElement;
let lanesEl: HTMLElement;
let playheadEl: HTMLElement;
let rulerPlayhead: HTMLElement;
let loopEl: HTMLElement | null = null;
let lastZoom = state.layout.arrangeZoom;
let itemDrag: ItemDrag | null = null;
let loopDrag: LoopDrag | null = null;
let scrubbing = false;
let lastSeekAt = 0;
let seekPending: number | null = null;
let seekTimer: number | undefined;
let followPlayback = true;
let playingLast = false;

function ppq(): number {
  return state.project.ppq;
}

function pxPerTick(): number {
  return state.layout.arrangeZoom / Math.max(1, state.project.ppq);
}

function tickToPx(tick: number): number {
  return tick * pxPerTick();
}

function tickFromClientX(clientX: number): number {
  const rect = lanesEl.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / Math.max(0.0001, pxPerTick()));
}

function snapTick(tick: number, disabled = false): number {
  const grid = disabled ? 0 : state.layout.snapTicks;
  if (grid <= 0) return Math.max(0, Math.round(tick));
  return Math.max(0, Math.round(tick / grid) * grid);
}

function projectWidthPx(): number {
  const bars = projectLengthBars(state.project);
  return Math.max(600, ticksToPx(bars * barTicks(state.project.ppq, state.project.timeSignature), state.layout.arrangeZoom, state.project.ppq));
}

export function mountArrangement(host: HTMLElement): void {
  hostEl = host;
  host.classList.add("arrangement");
  rulerEl = h("div", { class: "ruler-viewport" });
  rulerInner = h("div", { class: "ruler-inner" });
  rulerEl.append(rulerInner);
  headersEl = h("div", { class: "track-headers" });
  headersInner = h("div", { class: "track-headers-inner" });
  headersEl.append(headersInner);
  laneScroll = h("div", { class: "lane-scroll" });
  lanesEl = h("div", { class: "lanes" });
  laneScroll.append(lanesEl);
  playheadEl = h("div", { class: "playhead" });
  rulerPlayhead = h("div", { class: "ruler-playhead" });

  const corner = h(
    "div",
    { class: "arrange-corner" },
    h("span", { class: "corner-label", text: "Tracks" }),
    iconButton("plus", () => actions.openModal("addTrack"), {
      title: "Add track",
      className: "corner-add",
      size: 13,
    }),
  );

  host.append(corner, rulerEl, headersEl, laneScroll);
  lanesEl.append(playheadEl);

  laneScroll.addEventListener("scroll", syncScroll, { passive: true });
  rulerEl.addEventListener("pointerdown", onRulerPointerDown);
  rulerEl.addEventListener("wheel", onRulerWheel, { passive: false });

  store.on("project", renderAll);
  store.on("layout", () => {
    if (state.layout.arrangeZoom !== lastZoom) {
      const center =
        (laneScroll.scrollLeft + laneScroll.clientWidth / 2) /
        Math.max(0.0001, lastZoom / Math.max(1, state.project.ppq));
      renderAll(state.layout.arrangeZoom);
      laneScroll.scrollLeft = Math.max(0, tickToPx(center) - laneScroll.clientWidth / 2);
    } else {
      syncScroll();
    }
  });
  store.on("selection", applySelection);
  store.on("transport", updateTransport);
  store.on("waveform", redrawWaveforms);

  renderAll();
}

function syncScroll(): void {
  headersInner.style.transform = `translateY(${-laneScroll.scrollTop}px)`;
  rulerInner.style.transform = `translateX(${-laneScroll.scrollLeft}px)`;
}

function onRulerWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 / 1.18 : 1.18;
    const rect = rulerEl.getBoundingClientRect();
    const tick =
      (event.clientX - rect.left + laneScroll.scrollLeft) / Math.max(0.0001, pxPerTick());
    actions.setArrangeZoom(state.layout.arrangeZoom * direction);
    laneScroll.scrollLeft = Math.max(0, tickToPx(tick) - laneScroll.clientWidth / 2);
  }
}

function renderAll(zoomBefore?: number): void {
  if (!hostEl) return;
  const previousLeft = laneScroll.scrollLeft;
  const previousTop = laneScroll.scrollTop;
  const width = projectWidthPx();
  lanesEl.style.width = `${width}px`;
  rulerInner.style.width = `${width}px`;
  headersInner.style.height = "auto";
  lanesEl.style.minHeight = `${Math.max(0, laneScroll.clientHeight)}px`;

  renderRuler(width);
  renderHeaders();
  renderLanes(width);
  applySelection();
  updateTransport();
  laneScroll.scrollLeft = previousLeft;
  laneScroll.scrollTop = previousTop;
  syncScroll();
  lastZoom = state.layout.arrangeZoom;
  void zoomBefore;
}

function renderRuler(width: number): void {
  rulerInner.replaceChildren();
  const bar = barTicks(ppq(), state.project.timeSignature);
  const zoom = state.layout.arrangeZoom;
  const totalBars = Math.ceil(width / Math.max(1, tickToPx(bar)));
  const beat = beatTicks(ppq(), state.project.timeSignature);
  const showBeats = tickToPx(beat) >= 22;

  for (let index = 0; index < totalBars; index += 1) {
    const left = tickToPx(index * bar);
    const label = h(
      "span",
      { class: "bar-label", text: String(index + 1) },
    );
    rulerInner.append(
      h("div", {
        class: "bar-tick",
        style: { left: `${left}px`, width: `${tickToPx(bar)}px` },
      }),
      h("div", {
        class: "bar-line",
        style: { left: `${left}px` },
      }),
      label,
    );
    label.style.left = `${left + 5}px`;
    if (showBeats) {
      const beats = state.project.timeSignature.numerator;
      for (let b = 1; b < beats; b += 1) {
        rulerInner.append(
          h("div", {
            class: "beat-line",
            style: { left: `${left + tickToPx(b * beat)}px` },
          }),
        );
      }
    }
  }

  const loop = state.project.loopRegion;
  loopEl = h("div", {
    class: `loop-region ${loop.enabled ? "" : "is-disabled"}`.trim(),
    style: {
      left: `${tickToPx(loop.startTicks)}px`,
      width: `${Math.max(4, tickToPx(loop.endTicks - loop.startTicks))}px`,
    },
    dataset: { loop: "body" },
    title: "Drag to move the cycle region · Alt+drag the ruler to create one",
  });
  loopEl.append(
    h("div", { class: "loop-handle start", dataset: { loop: "start" } }),
    h("span", { class: "loop-label", text: "Cycle" }),
    h("div", { class: "loop-handle end", dataset: { loop: "end" } }),
  );
  loopEl.addEventListener("pointerdown", onLoopPointerDown);
  rulerInner.append(loopEl);

  for (const marker of state.project.markers) {
    const markerEl = h(
      "div",
      {
        class: "marker",
        style: { left: `${tickToPx(marker.ticks)}px`, color: marker.color },
        title: `${marker.name} · ${formatBarsBeats(marker.ticks, ppq(), state.project.timeSignature)}`,
        dataset: { markerId: marker.id },
      },
      h("span", { class: "marker-flag" }),
      h("span", { class: "marker-name", text: marker.name }),
    );
    markerEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      void actions.seekTicks(marker.ticks);
    });
    markerEl.addEventListener("contextmenu", (event) => {
      openContextMenu(event, [
        {
          label: "Rename Marker",
          action: () => {
            const name = window.prompt("Marker name", marker.name);
            if (name) actions.renameMarker(marker.id, name.trim());
          },
        },
        {
          label: "Set Cycle to Marker",
          action: () => {
            const end =
              state.project.markers.find((entry) => entry.ticks > marker.ticks)?.ticks ??
              marker.ticks + barTicks(ppq(), state.project.timeSignature) * 2;
            actions.setLoop(true, marker.ticks, end);
          },
        },
        { separator: true },
        { label: "Delete Marker", danger: true, action: () => actions.removeMarker(marker.id) },
      ]);
    });
    rulerInner.append(markerEl);
  }

  rulerInner.append(rulerPlayhead);
}

function renderHeaders(): void {
  headersInner.replaceChildren();
  for (const track of state.project.tracks) {
    headersInner.append(buildTrackHeader(track));
  }
  const add = h(
    "button",
    {
      class: "add-track-row",
      type: "button",
      title: "Add track",
      onClick: () => actions.openModal("addTrack"),
    },
    icon("plus", 12),
    h("span", { text: "Add Track" }),
  );
  headersInner.append(add);
}

function buildTrackHeader(track: Track): HTMLElement {
  const kindIcon =
    track.kind === "audio"
      ? "wave"
      : track.kind === "instrument"
        ? "synth"
        : track.kind === "midi"
          ? "keyboard"
          : track.kind === "group"
            ? "layers"
            : track.kind === "fx"
              ? "sparkle"
              : "file";

  const name = h("span", { class: "track-name", text: track.name });
  const header = h(
    "div",
    {
      class: `track-head ${state.selection.trackId === track.id ? "is-selected" : ""}`,
      style: {
        height: `${track.height}px`,
        "--track-color": track.color,
      } as Partial<CSSStyleDeclaration>,
      dataset: { trackId: track.id },
    },
  );
  const nameRow = h(
    "div",
    { class: "track-head-row name-row" },
    h("span", { class: "track-kind-icon" }, icon(kindIcon, 12)),
    name,
    h("span", { class: "track-index", text: String(state.project.tracks.indexOf(track) + 1) }),
  );
  name.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    const input = inlineRename(track.name, (value) => actions.renameTrack(track.id, value));
    name.replaceWith(input);
  });

  const mute = h("button", {
    class: `mini-btn mute ${track.mute ? "is-active" : ""}`,
    type: "button",
    text: "M",
    title: "Mute",
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      actions.toggleMute(track.id);
    },
  });
  const solo = h("button", {
    class: `mini-btn solo ${track.solo ? "is-active" : ""}`,
    type: "button",
    text: "S",
    title: "Solo",
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      actions.toggleSolo(track.id);
    },
  });
  const rec = h("button", {
    class: `mini-btn rec ${track.recordArm ? "is-active" : ""}`,
    type: "button",
    text: "R",
    title: "Record enable (recording not implemented)",
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      actions.toggleRecordArm(track.id);
    },
  });

  const volume = rangeControl({
    value: track.volumeDb,
    min: -96,
    max: 12,
    step: 0.1,
    format: (value) => `${formatDb(value)} dB`,
    className: "track-vol",
    ariaLabel: `${track.name} volume`,
    showValue: false,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setTrackVolume(track.id, value, true),
    onEnd: () => actions.endGesture("project"),
  });
  volume.element.addEventListener("pointerdown", (event) => event.stopPropagation());

  const controls = h(
    "div",
    { class: "track-head-row controls-row" },
    h("div", { class: "track-msr" }, mute, solo, rec),
    h("span", { class: "track-route", text: track.output === "master" ? "→ Master" : "→ Bus" }),
  );
  const meter = h("div", { class: "track-meter" }, h("div", { class: "track-meter-fill" }));
  meter.dataset.meterId = track.id;

  header.append(
    h("span", { class: "track-color-bar" }),
    nameRow,
    controls,
    h("div", { class: "track-head-row fader-row" }, volume.element, meter),
    h("div", { class: "track-resize", title: "Drag to change track height" }),
  );

  header.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("button, input, .track-resize, .inline-rename")) return;
    actions.selectTrack(track.id);
  });
  header.addEventListener("contextmenu", (event) => {
    actions.selectTrack(track.id);
    openContextMenu(event, trackMenu(track));
  });

  const resize = header.querySelector<HTMLElement>(".track-resize");
  if (resize) {
    resize.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startHeight = track.height;
      actions.beginGesture();
      resize.setPointerCapture(event.pointerId);
      let moved = false;
      const move = (moveEvent: PointerEvent): void => {
        moved = true;
        const next = clamp(startHeight + moveEvent.clientY - startY, 38, 220);
        actions.setTrackHeight(track.id, next, true);
        header.style.height = `${next}px`;
        const lane = lanesEl.querySelector<HTMLElement>(`[data-lane-track="${track.id}"]`);
        if (lane) lane.style.height = `${next}px`;
      };
      const end = (endEvent: PointerEvent): void => {
        resize.removeEventListener("pointermove", move);
        resize.removeEventListener("pointerup", end);
        resize.removeEventListener("pointercancel", end);
        if (resize.hasPointerCapture(endEvent.pointerId)) resize.releasePointerCapture(endEvent.pointerId);
        if (moved) actions.endGesture("project");
        else actions.cancelGesture();
      };
      resize.addEventListener("pointermove", move);
      resize.addEventListener("pointerup", end);
      resize.addEventListener("pointercancel", end);
    });
  }

  return header;
}

function trackMenu(track: Track): Parameters<typeof openContextMenu>[1] {
  return [
    {
      label: "Add MIDI Part at Cursor",
      disabled: track.kind !== "instrument" && track.kind !== "midi",
      action: () =>
        actions.addMidiPart(
          track.id,
          state.transport?.positionTicks ?? 0,
        ),
    },
    {
      label: "Import Audio Here…",
      action: () =>
        actions.importAudioFile(undefined, {
          trackId: track.id,
          startTicks: state.transport?.positionTicks ?? 0,
        }),
    },
    { separator: true },
    { label: "Rename Track", action: () => {
        const name = window.prompt("Track name", track.name);
        if (name) actions.renameTrack(track.id, name);
      } },
    { label: "Duplicate Track", action: () => actions.duplicateTrack(track.id) },
    { separator: true },
    { label: "Delete Track", danger: true, action: () => actions.deleteTrack(track.id) },
  ];
}

function renderLanes(width: number): void {
  lanesEl.replaceChildren(playheadEl);
  lanesEl.style.width = `${width}px`;
  const bar = barTicks(ppq(), state.project.timeSignature);
  const beat = beatTicks(ppq(), state.project.timeSignature);

  for (const track of state.project.tracks) {
    const lane = h("div", {
      class: `lane lane-${track.kind}`,
      style: {
        height: `${track.height}px`,
        "--track-color": track.color,
        "--bar-px": `${tickToPx(bar)}px`,
        "--beat-px": `${tickToPx(beat)}px`,
        backgroundSize: `${tickToPx(bar)}px 100%, ${tickToPx(beat)}px 100%`,
      } as Partial<CSSStyleDeclaration>,
      dataset: { laneTrack: track.id, trackId: track.id },
    });

    for (const clip of track.clips) lane.append(buildClip(track, clip));
    for (const part of track.parts) lane.append(buildPart(track, part));

    lane.addEventListener("pointerdown", (event) => {
      if (event.target !== lane) return;
      actions.selectTrack(track.id);
      followPlayback = false;
    });
    lane.addEventListener("dblclick", (event) => {
      if (event.target !== lane) return;
      const tick = snapTick(tickFromClientX(event.clientX), event.altKey);
      if (track.kind === "instrument" || track.kind === "midi") {
        actions.addMidiPart(track.id, tick);
        actions.setBottomTab("piano");
      } else if (track.kind === "audio") {
        void actions.importAudioFile(undefined, { trackId: track.id, startTicks: tick });
      }
    });
    lane.addEventListener("contextmenu", (event) => {
      if (event.target !== lane) return;
      actions.selectTrack(track.id);
      openContextMenu(event, [
        {
          label: "Add MIDI Part Here",
          disabled: track.kind !== "instrument" && track.kind !== "midi",
          action: () => {
            const tick = snapTick(tickFromClientX(event.clientX));
            actions.addMidiPart(track.id, tick);
          },
        },
        {
          label: "Import Audio Here…",
          action: () => {
            const tick = snapTick(tickFromClientX(event.clientX));
            void actions.importAudioFile(undefined, { trackId: track.id, startTicks: tick });
          },
        },
        {
          label: "Add Marker Here",
          action: () => actions.addMarker(snapTick(tickFromClientX(event.clientX))),
        },
        { separator: true },
        { label: "Add Track…", action: () => actions.openModal("addTrack") },
      ]);
    });

    lanesEl.append(lane);
  }

  const addLane = h(
    "button",
    {
      class: "add-track-lane",
      type: "button",
      onClick: () => actions.openModal("addTrack"),
    },
    icon("plus", 12),
    h("span", { text: "Add Track" }),
  );
  lanesEl.append(addLane);
  lanesEl.append(playheadEl);
}

function buildClip(track: Track, clip: AudioClip): HTMLElement {
  const left = tickToPx(clip.startTicks);
  const width = Math.max(3, tickToPx(clip.durationTicks));
  const height = Math.max(20, track.height - 8);
  const canvas = h("canvas", { class: "clip-canvas" });
  const element = h(
    "div",
    {
      class: `clip audio-clip ${state.selection.clipId === clip.id ? "is-selected" : ""}`,
      style: {
        left: `${left}px`,
        width: `${width}px`,
        height: `${height}px`,
        "--clip-color": clip.color || track.color,
      } as Partial<CSSStyleDeclaration>,
      dataset: { clipId: clip.id, trackId: track.id },
      title: `${clip.name}\n${formatBarsBeats(clip.startTicks, ppq(), state.project.timeSignature)} · ${(clip.durationTicks / ppq()).toFixed(2)} beats`,
    },
    canvas,
    buildFade(clip.fadeInTicks, "in"),
    buildFade(clip.fadeOutTicks, "out"),
    h(
      "div",
      { class: "clip-label" },
      h("span", { class: "clip-name", text: clip.name }),
      clip.gainDb !== 0 ? h("span", { class: "clip-gain", text: `${formatDb(clip.gainDb)} dB` }) : null,
    ),
    h("div", { class: "clip-edge left", dataset: { edge: "left" } }),
    h("div", { class: "clip-edge right", dataset: { edge: "right" } }),
  );
  paintWaveform(canvas, clip, width, height - 14);
  attachItemEvents(element, track, clip, "clip");
  return element;
}

function buildPart(track: Track, part: MidiPart): HTMLElement {
  const left = tickToPx(part.startTicks);
  const width = Math.max(3, tickToPx(part.durationTicks));
  const height = Math.max(20, track.height - 8);
  const canvas = h("canvas", { class: "part-canvas" });
  const element = h(
    "div",
    {
      class: `clip midi-part ${state.selection.partId === part.id ? "is-selected" : ""}`,
      style: {
        left: `${left}px`,
        width: `${width}px`,
        height: `${height}px`,
        "--clip-color": part.color || track.color,
      } as Partial<CSSStyleDeclaration>,
      dataset: { partId: part.id, trackId: track.id },
      title: `${part.name}\n${part.notes.length} notes · ${(part.durationTicks / ppq()).toFixed(2)} beats`,
    },
    canvas,
    h(
      "div",
      { class: "clip-label" },
      h("span", { class: "clip-name", text: part.name }),
      h("span", { class: "clip-notes", text: `${part.notes.length}` }),
    ),
    h("div", { class: "clip-edge right", dataset: { edge: "right" } }),
  );
  paintPart(canvas, part, width, height - 14);
  attachItemEvents(element, track, part, "part");
  return element;
}

function buildFade(ticks: number, direction: "in" | "out"): HTMLElement | null {
  if (ticks <= 0) return null;
  return h("div", {
    class: `clip-fade fade-${direction}`,
    style: { width: `${Math.max(2, tickToPx(ticks))}px` },
  });
}

function attachItemEvents(
  element: HTMLElement,
  track: Track,
  item: AudioClip | MidiPart,
  type: "clip" | "part",
): void {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const itemId = item.id;
    if (type === "clip") actions.selectClip(track.id, itemId);
    else actions.selectPart(track.id, itemId);

    if (state.layout.tool === "split") {
      const tick = snapTick(tickFromClientX(event.clientX), event.altKey);
      if (type === "clip") actions.splitClip(track.id, itemId, tick);
      else actions.splitPart(track.id, itemId, tick);
      return;
    }

    const target = event.target as HTMLElement;
    const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
    let kind: DragKind = "move";
    if (edge === "left") kind = "resize-left";
    else if (edge === "right") kind = "resize-right";
    else if (type === "part" && event.offsetX > element.clientWidth - 7) kind = "resize-right";

    itemDrag = {
      kind,
      type,
      trackId: track.id,
      itemId,
      element,
      startX: event.clientX,
      startTicks: item.startTicks,
      durationTicks: item.durationTicks,
      offsetTicks: type === "clip" ? (item as AudioClip).offsetTicks : 0,
      moved: false,
      partStart: item.startTicks,
    };
    actions.beginGesture();
    element.classList.add("is-dragging");
    element.setPointerCapture(event.pointerId);
    followPlayback = false;

    const move = (moveEvent: PointerEvent): void => {
      if (!itemDrag) return;
      const deltaTicks = (moveEvent.clientX - itemDrag.startX) / Math.max(0.0001, pxPerTick());
      if (Math.abs(deltaTicks) < 0.5) return;
      itemDrag.moved = true;
      const grid = moveEvent.altKey ? 0 : state.layout.snapTicks;
      const original = itemDrag.startTicks;
      const originalEnd = original + itemDrag.durationTicks;
      if (itemDrag.kind === "move") {
        const next = snapTick(original + deltaTicks, moveEvent.altKey);
        itemDrag.element.style.left = `${tickToPx(next)}px`;
        if (type === "clip") {
          actions.updateClip(track.id, itemDrag.itemId, { startTicks: next }, true);
        } else {
          actions.updatePart(track.id, itemDrag.itemId, { startTicks: next }, true);
        }
      } else if (itemDrag.kind === "resize-right") {
        const rawEnd = originalEnd + deltaTicks;
        const snapped = grid > 0 ? Math.round(rawEnd / grid) * grid : Math.round(rawEnd);
        const end = Math.max(original + Math.max(1, grid || 1), snapped);
        const duration = Math.max(1, end - original);
        itemDrag.element.style.width = `${Math.max(3, tickToPx(duration))}px`;
        if (type === "clip") {
          actions.updateClip(track.id, itemDrag.itemId, { durationTicks: duration }, true);
          const canvas = itemDrag.element.querySelector<HTMLCanvasElement>(".clip-canvas");
          if (canvas) paintWaveform(canvas, { ...item, durationTicks: duration } as AudioClip, tickToPx(duration), canvas.clientHeight);
        } else {
          actions.updatePart(track.id, itemDrag.itemId, { durationTicks: duration }, true);
          const canvas = itemDrag.element.querySelector<HTMLCanvasElement>(".part-canvas");
          if (canvas) paintPart(canvas, item as MidiPart, tickToPx(duration), canvas.clientHeight);
        }
      } else {
        const rawStart = original + deltaTicks;
        const snapped = grid > 0 ? Math.round(rawStart / grid) * grid : Math.round(rawStart);
        const start = clamp(snapped, 0, originalEnd - Math.max(1, grid || 1));
        const duration = originalEnd - start;
        itemDrag.element.style.left = `${tickToPx(start)}px`;
        itemDrag.element.style.width = `${Math.max(3, tickToPx(duration))}px`;
        if (type === "clip") {
          const offset = Math.max(0, itemDrag.offsetTicks + (start - original));
          actions.updateClip(
            track.id,
            itemDrag.itemId,
            { startTicks: start, durationTicks: duration, offsetTicks: offset },
            true,
          );
        } else {
          actions.updatePart(track.id, itemDrag.itemId, { startTicks: start }, true);
        }
      }
    };

    const end = (endEvent: PointerEvent): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      if (element.hasPointerCapture(endEvent.pointerId)) element.releasePointerCapture(endEvent.pointerId);
      element.classList.remove("is-dragging");
      const moved = itemDrag?.moved ?? false;
      if (moved) actions.endGesture("project");
      else actions.cancelGesture();
      itemDrag = null;
    };

    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  });

  element.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    if (type === "part") {
      actions.selectPart(track.id, item.id, true);
    } else {
      actions.selectClip(track.id, item.id);
      actions.setLeftTab("inspector");
    }
  });

  element.addEventListener("contextmenu", (event) => {
    event.stopPropagation();
    if (type === "clip") actions.selectClip(track.id, item.id);
    else actions.selectPart(track.id, item.id);
    const tick = snapTick(tickFromClientX(event.clientX));
    openContextMenu(event, [
      {
        label: "Open in Piano Roll",
        disabled: type !== "part",
        action: () => actions.selectPart(track.id, item.id, true),
      },
      {
        label: "Split at Cursor",
        action: () =>
          type === "clip"
            ? actions.splitClip(track.id, item.id, state.transport?.positionTicks ?? tick)
            : actions.splitPart(track.id, item.id, state.transport?.positionTicks ?? tick),
      },
      {
        label: "Split Here",
        action: () =>
          type === "clip"
            ? actions.splitClip(track.id, item.id, tick)
            : actions.splitPart(track.id, item.id, tick),
      },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        action: () =>
          type === "clip"
            ? actions.duplicateClip(track.id, item.id)
            : actions.duplicatePart(track.id, item.id),
      },
      { separator: true },
      {
        label: "Delete",
        danger: true,
        shortcut: "Del",
        action: () =>
          type === "clip"
            ? actions.deleteClip(track.id, item.id)
            : actions.deletePart(track.id, item.id),
      },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Ruler, cycle region, scrubbing
// ---------------------------------------------------------------------------

function onRulerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest(".loop-region, .marker")) return;
  const rect = rulerEl.getBoundingClientRect();
  const tick = (event.clientX - rect.left + laneScroll.scrollLeft) / Math.max(0.0001, pxPerTick());

  if (event.altKey) {
    actions.beginGesture();
    const start = snapTick(tick, event.altKey);
    loopDrag = {
      mode: "new",
      anchorTicks: start,
      originalStart: start,
      originalEnd: start,
      moved: false,
    };
    setLoopVisual(Math.max(0, start - 1), start, true);
    attachLoopMove();
    return;
  }

  scrubbing = true;
  followPlayback = false;
  seekThrottled(snapTick(tick, event.altKey));
  const move = (moveEvent: PointerEvent): void => {
    if (!scrubbing) return;
    const moveTick =
      (moveEvent.clientX - rect.left + laneScroll.scrollLeft) / Math.max(0.0001, pxPerTick());
    seekThrottled(snapTick(moveTick, moveEvent.altKey), moveEvent.clientX);
  };
  const up = (): void => {
    scrubbing = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function seekThrottled(tick: number, clientX?: number): void {
  if (clientX !== undefined) {
    // Keep the visual playhead responsive while the backend seek is throttled.
    const px = tickToPx(tick);
    playheadEl.style.left = `${px}px`;
    rulerPlayhead.style.left = `${px}px`;
  }
  seekPending = Math.max(0, Math.round(tick));
  const now = performance.now();
  const send = (): void => {
    lastSeekAt = performance.now();
    seekTimer = undefined;
    if (seekPending === null) return;
    const value = seekPending;
    seekPending = null;
    void actions.seekTicks(value);
  };
  if (now - lastSeekAt >= 45) {
    send();
  } else if (seekTimer === undefined) {
    seekTimer = window.setTimeout(send, 45 - (now - lastSeekAt));
  }
}

function onLoopPointerDown(event: PointerEvent): void {
  event.stopPropagation();
  event.preventDefault();
  const target = event.target as HTMLElement;
  const handle = target.closest<HTMLElement>("[data-loop]")?.dataset.loop ?? "body";
  const rect = rulerEl.getBoundingClientRect();
  const tick = (event.clientX - rect.left + laneScroll.scrollLeft) / Math.max(0.0001, pxPerTick());
  const loop = state.project.loopRegion;
  actions.beginGesture();
  loopDrag = {
    mode: handle === "start" ? "start" : handle === "end" ? "end" : "body",
    anchorTicks: tick,
    originalStart: loop.startTicks,
    originalEnd: loop.endTicks,
    moved: false,
  };
  followPlayback = false;
  attachLoopMove();
}

function attachLoopMove(): void {
  const rect = rulerEl.getBoundingClientRect();
  const move = (event: PointerEvent): void => {
    if (!loopDrag) return;
    const tick = (event.clientX - rect.left + laneScroll.scrollLeft) / Math.max(0.0001, pxPerTick());
    const grid = event.altKey ? 0 : state.layout.snapTicks;
    const loop = state.project.loopRegion;
    let start = loop.startTicks;
    let end = loop.endTicks;
    if (loopDrag.mode === "new") {
      const anchor = loopDrag.anchorTicks;
      const current = snapTick(tick, event.altKey);
      start = Math.min(anchor, current);
      end = Math.max(anchor + Math.max(1, state.project.ppq), current);
    } else if (loopDrag.mode === "body") {
      const delta = tick - loopDrag.anchorTicks;
      const length = loopDrag.originalEnd - loopDrag.originalStart;
      const snapped = grid > 0 ? Math.round(delta / grid) * grid : Math.round(delta);
      start = Math.max(0, loopDrag.originalStart + snapped);
      end = start + length;
    } else if (loopDrag.mode === "start") {
      start = clamp(
        snapTick(tick, event.altKey),
        0,
        Math.max(1, loop.endTicks - Math.max(1, state.layout.snapTicks)),
      );
      end = loopDrag.originalEnd;
    } else {
      start = loop.startTicks;
      end = Math.max(start + Math.max(1, state.layout.snapTicks || 1), snapTick(tick, event.altKey));
    }
    loop.startTicks = start;
    loop.endTicks = Math.max(start + 1, end);
    loop.enabled = true;
    loopDrag.moved = true;
    setLoopVisual(loop.startTicks, loop.endTicks, true);
    state.dirty = true;
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    const moved = loopDrag?.moved ?? false;
    loopDrag = null;
    if (moved) {
      const loop = state.project.loopRegion;
      void api.transportSetLoop(true, loop.startTicks, loop.endTicks).catch(() => undefined);
      actions.endGesture("project");
    } else {
      actions.cancelGesture();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function setLoopVisual(startTicks: number, endTicks: number, enabled: boolean): void {
  if (!loopEl) return;
  loopEl.style.left = `${tickToPx(startTicks)}px`;
  loopEl.style.width = `${Math.max(4, tickToPx(endTicks - startTicks))}px`;
  loopEl.classList.toggle("is-disabled", !enabled);
}

// ---------------------------------------------------------------------------
// Selection, playhead, waveforms
// ---------------------------------------------------------------------------

function applySelection(): void {
  for (const element of lanesEl.querySelectorAll<HTMLElement>(".clip")) {
    const isClip = state.selection.clipId === element.dataset.clipId;
    const isPart = state.selection.partId === element.dataset.partId;
    element.classList.toggle("is-selected", Boolean(isClip || isPart));
  }
  for (const element of headersInner.querySelectorAll<HTMLElement>(".track-head")) {
    element.classList.toggle("is-selected", element.dataset.trackId === state.selection.trackId);
  }
}

function updateTransport(): void {
  const transport = state.transport;
  if (!transport) return;
  const px = tickToPx(transport.positionTicks);
  playheadEl.style.left = `${px}px`;
  rulerPlayhead.style.left = `${px}px`;
  if (transport.playing && followPlayback) {
    const viewLeft = laneScroll.scrollLeft;
    const viewRight = viewLeft + laneScroll.clientWidth;
    if (px < viewLeft + 12 || px > viewRight - 60) {
      laneScroll.scrollLeft = Math.max(0, px - laneScroll.clientWidth * 0.25);
    }
  }
  if (transport.playing && !playingLast) followPlayback = true;
  playingLast = transport.playing;

  for (const meter of lanesEl.querySelectorAll<HTMLElement>(".track-meter")) {
    const trackId = meter.dataset.meterId ?? "";
    const peak = transport.meters.find((entry) => entry.trackId === trackId)?.peak ?? 0;
    const fill = meter.firstElementChild as HTMLElement | null;
    if (fill) fill.style.width = `${clamp(Math.pow(peak, 0.5), 0, 1) * 100}%`;
    meter.classList.toggle("is-hot", peak > 0.96);
  }
}

function redrawWaveforms(): void {
  for (const canvas of lanesEl.querySelectorAll<HTMLCanvasElement>(".clip-canvas")) {
    const clipEl = canvas.closest<HTMLElement>(".audio-clip");
    if (!clipEl) continue;
    const track = state.project.tracks.find((entry) => entry.id === clipEl.dataset.trackId);
    const clip = track?.clips.find((entry) => entry.id === clipEl.dataset.clipId);
    if (!clip) continue;
    paintWaveform(canvas, clip, clipEl.clientWidth, Math.max(10, clipEl.clientHeight - 14));
  }
}

function paintWaveform(
  canvas: HTMLCanvasElement,
  clip: AudioClip,
  width: number,
  height: number,
): void {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  canvas.style.width = `${safeWidth}px`;
  canvas.style.height = `${safeHeight}px`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, safeWidth, safeHeight);
  const peaks = actions.waveformPeaks(clip.mediaPath);
  const middle = safeHeight / 2;
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.beginPath();
  context.moveTo(0, middle);
  context.lineTo(safeWidth, middle);
  context.stroke();
  if (!peaks || peaks.length === 0) {
    if (peaks) {
      context.fillStyle = "rgba(255,255,255,0.25)";
      context.font = "10px Segoe UI";
      context.fillText("No waveform", 5, Math.max(10, middle + 3));
    }
    return;
  }
  context.fillStyle = "rgba(255,255,255,0.58)";
  const buckets = Math.min(safeWidth, 1600);
  const step = Math.max(1, Math.floor(peaks.length / buckets));
  for (let x = 0; x < buckets; x += 1) {
    const start = Math.floor((x / buckets) * peaks.length);
    let peak = 0;
    for (let index = start; index < Math.min(peaks.length, start + step); index += 1) {
      peak = Math.max(peak, peaks[index]);
    }
    const barHeight = Math.max(0.5, peak * (safeHeight - 2));
    const barX = Math.round((x / buckets) * safeWidth);
    const barWidth = Math.max(1, Math.round(safeWidth / buckets) - 0.3);
    context.fillRect(barX, middle - barHeight / 2, barWidth, barHeight);
  }
}

function paintPart(canvas: HTMLCanvasElement, part: MidiPart, width: number, height: number): void {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  canvas.style.width = `${safeWidth}px`;
  canvas.style.height = `${safeHeight}px`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, safeWidth, safeHeight);
  if (part.notes.length === 0) {
    context.fillStyle = "rgba(255,255,255,0.35)";
    context.font = "10px Segoe UI";
    context.fillText("Empty part", 5, Math.max(11, safeHeight / 2 + 3));
    return;
  }
  let low = 127;
  let high = 0;
  for (const note of part.notes) {
    low = Math.min(low, note.pitch);
    high = Math.max(high, note.pitch);
  }
  low = clamp(low - 2, 0, 127);
  high = clamp(high + 2, 0, 127);
  const range = Math.max(1, high - low);
  const duration = Math.max(1, part.durationTicks);
  context.fillStyle = "rgba(255,255,255,0.62)";
  for (const note of part.notes) {
    const x = (note.startTicks / duration) * safeWidth;
    const noteWidth = Math.max(1, (note.durationTicks / duration) * safeWidth);
    const y = ((high - note.pitch) / range) * (safeHeight - 2);
    const noteHeight = Math.max(1.5, safeHeight / (range + 1) - 0.5);
    context.globalAlpha = 0.35 + (note.velocity / 127) * 0.55;
    context.fillRect(x, y, noteWidth, noteHeight);
  }
  context.globalAlpha = 1;
}

export function partNoteLabel(pitch: number): string {
  return noteName(pitch);
}

export function newPartNamed(track: Track): MidiPart {
  return {
    id: uuid(),
    name: `${track.name} Part`,
    startTicks: 0,
    durationTicks: state.project.ppq * 4,
    color: track.color,
    notes: [],
  };
}
