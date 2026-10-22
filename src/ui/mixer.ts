import * as actions from "../actions";
import { state, store } from "../store";
import type { InsertEffect, Track } from "../types";
import { h } from "../utils/dom";
import { formatDb } from "../utils/format";
import {
  iconButton,
  inlineRename,
  rangeControl,
  verticalFader,
  type FaderControl,
} from "./controls";
import { EFFECT_MENU, effectDef } from "./effects";
import { icon } from "./icons";
import { openContextMenu, openMenuFor } from "./menu";

let stripsHost: HTMLElement;
let masterHost: HTMLElement;
let toolbar: HTMLElement;
let host: HTMLElement;
const faders = new Map<string, FaderControl>();

export function mountMixer(element: HTMLElement): void {
  host = element;
  host.classList.add("mixer-panel");
  toolbar = h("div", { class: "mixer-toolbar panel-toolbar" });
  stripsHost = h("div", { class: "mixer-strips" });
  masterHost = h("div", { class: "mixer-master" });
  const body = h("div", { class: "mixer-body" }, stripsHost, masterHost);
  host.append(toolbar, body);

  store.on("project", render);
  store.on("selection", applySelection);
  store.on("transport", updateMeters);
  render();
}

function render(): void {
  faders.clear();
  toolbar.replaceChildren(
    h(
      "span",
      { class: "piano-title" },
      icon("mixer", 14),
      h("span", { text: "MixConsole" }),
      h("span", { class: "mixer-count", text: `${state.project.tracks.length} channels` }),
    ),
    h("div", { class: "toolbar-spacer" }),
    h(
      "button",
      { class: "text-btn", type: "button", onClick: () => actions.openModal("addTrack") },
      "Add Channel",
    ),
    iconButton("close", () => actions.setBottomTab("none"), { title: "Close MixConsole" }),
  );
  stripsHost.replaceChildren();
  for (const track of state.project.tracks) {
    stripsHost.append(buildStrip(track));
  }
  const add = h(
    "button",
    {
      class: "mixer-add",
      type: "button",
      onClick: () => actions.openModal("addTrack"),
    },
    icon("plus", 18),
    h("span", { text: "Add Channel" }),
  );
  stripsHost.append(add);
  masterHost.replaceChildren(buildMasterStrip());
  applySelection();
  updateMeters();
}

function buildStrip(track: Track): HTMLElement {
  const insertList = h("div", { class: "inserts-list" });
  const visibleInserts = track.inserts.slice(0, 4);
  for (const insert of visibleInserts) insertList.append(buildInsertRow(track.id, insert));
  const addInsert = h(
    "button",
    {
      class: "insert-add",
      type: "button",
      title: "Add insert effect",
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        openMenuFor(
          addInsert,
          EFFECT_MENU.map((entry) => ({
            label: entry.name,
            action: () => actions.addInsert(track.id, entry.kind),
          })),
          180,
        );
      },
    },
    icon("plus", 10),
    h("span", { text: track.inserts.length > 4 ? `${track.inserts.length - 4} more…` : "Insert" }),
  );
  insertList.append(addInsert);

  const pan = rangeControl({
    value: track.pan,
    min: -1,
    max: 1,
    step: 0.01,
    format: (value) => (Math.abs(value) < 0.01 ? "C" : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`),
    className: "pan-control",
    ariaLabel: `${track.name} pan`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setTrackPan(track.id, value, true),
    onEnd: () => actions.endGesture("project"),
  });

  const fader = verticalFader({
    valueDb: track.volumeDb,
    height: 148,
    onStart: () => actions.beginGesture(),
    onPreview: (db) => actions.setTrackVolume(track.id, db, true),
    onEnd: () => actions.endGesture("project"),
  });
  faders.set(track.id, fader);

  const outputOptions = [
    { label: "→ Master", value: "master" },
    ...state.project.tracks
      .filter((entry) => entry.id !== track.id && (entry.kind === "group" || entry.kind === "fx"))
      .map((entry) => ({ label: `→ ${entry.name}`, value: entry.id })),
  ];
  const route = h(
    "select",
    {
      class: "strip-route",
      title: "Output routing",
      onChange: (event: Event) =>
        actions.setTrackOutput(track.id, (event.target as HTMLSelectElement).value),
    },
    ...outputOptions.map((option) =>
      h("option", { value: option.value, text: option.label, selected: track.output === option.value }),
    ),
  );

  if (!outputOptions.some((option) => option.value === track.output)) {
    route.append(h("option", { value: track.output, text: "→ Missing bus", selected: true }));
  }

  const name = h("span", { class: "strip-name", text: track.name });
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
    title: "Record enable",
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      actions.toggleRecordArm(track.id);
    },
  });

  const strip = h(
    "div",
    {
      class: `strip ${state.selection.trackId === track.id ? "is-selected" : ""}`,
      dataset: { trackId: track.id },
      style: { "--track-color": track.color } as Partial<CSSStyleDeclaration>,
    },
    h("div", { class: "strip-color" }),
    h(
      "div",
      { class: "strip-header" },
      h("span", { class: "strip-index", text: String(state.project.tracks.indexOf(track) + 1) }),
      name,
    ),
    h("div", { class: "strip-kind", text: kindLabel(track) }),
    insertList,
    h("div", { class: "strip-pan" }, pan.element),
    route,
    h("div", { class: "strip-fader-row" }, fader.element),
    h("div", { class: "strip-buttons" }, mute, solo, rec),
  );

  strip.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("input, select, button, .inline-rename")) return;
    actions.selectTrack(track.id);
  });
  strip.addEventListener("contextmenu", (event) => {
    openContextMenu(event, [
      { label: "Rename Channel", action: () => {
          const value = window.prompt("Channel name", track.name);
          if (value) actions.renameTrack(track.id, value);
        } },
      { label: "Duplicate Channel", action: () => actions.duplicateTrack(track.id) },
      { separator: true },
      { label: "Delete Channel", danger: true, action: () => actions.deleteTrack(track.id) },
    ]);
  });
  return strip;
}

function kindLabel(track: Track): string {
  switch (track.kind) {
    case "audio":
      return "Audio";
    case "instrument":
      return "Instrument";
    case "midi":
      return "MIDI";
    case "group":
      return "Group";
    case "fx":
      return "FX";
    default:
      return track.kind;
  }
}

function buildInsertRow(hostId: string, insert: InsertEffect): HTMLElement {
  const def = effectDef(insert.kind);
  const button = h(
    "button",
    {
      class: `insert-row ${insert.enabled ? "" : "is-bypassed"}`.trim(),
      type: "button",
      title: `${def.name} — click to edit`,
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        actions.openModal("effect", { host: hostId, effectId: insert.id });
      },
    },
    h("span", {
      class: `insert-state ${insert.enabled ? "is-on" : ""}`,
      title: insert.enabled ? "Bypass" : "Enable",
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        actions.toggleInsert(hostId, insert.id);
      },
    }),
    h("span", { class: "insert-name", text: def.short }),
  );
  button.addEventListener("contextmenu", (event) => {
    event.stopPropagation();
    openContextMenu(event, [
      { label: insert.enabled ? "Bypass" : "Enable", action: () => actions.toggleInsert(hostId, insert.id) },
      { label: "Move Up", action: () => actions.moveInsert(hostId, insert.id, -1) },
      { label: "Move Down", action: () => actions.moveInsert(hostId, insert.id, 1) },
      { separator: true },
      { label: "Remove Insert", danger: true, action: () => actions.removeInsert(hostId, insert.id) },
    ]);
  });
  return button;
}

function buildMasterStrip(): HTMLElement {
  const master = state.project.master;
  const insertList = h("div", { class: "inserts-list" });
  for (const insert of master.inserts.slice(0, 4)) insertList.append(buildInsertRow("master", insert));
  const addInsert = h(
    "button",
    {
      class: "insert-add",
      type: "button",
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        openMenuFor(
          addInsert,
          EFFECT_MENU.map((entry) => ({
            label: entry.name,
            action: () => actions.addInsert("master", entry.kind),
          })),
          180,
        );
      },
    },
    icon("plus", 10),
    h("span", { text: "Insert" }),
  );
  insertList.append(addInsert);

  const pan = rangeControl({
    value: master.pan,
    min: -1,
    max: 1,
    step: 0.01,
    format: (value) => (Math.abs(value) < 0.01 ? "C" : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`),
    className: "pan-control",
    ariaLabel: "Master pan",
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setMasterPan(value, true),
    onEnd: () => actions.endGesture("project"),
  });

  const fader = verticalFader({
    valueDb: master.volumeDb,
    height: 176,
    onStart: () => actions.beginGesture(),
    onPreview: (db) => actions.setMasterVolume(db, true),
    onEnd: () => actions.endGesture("project"),
  });
  faders.set("master", fader);

  const limiter = h(
    "button",
    {
      class: `limiter-btn ${master.limiter ? "is-active" : ""}`,
      type: "button",
      title: "Master brickwall limiter",
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        actions.setMasterLimiter(!master.limiter);
      },
    },
    icon("power", 11),
    h("span", { text: "Limiter" }),
  );

  return h(
    "div",
    { class: "strip master-strip", style: { "--track-color": "#b9b9b9" } as Partial<CSSStyleDeclaration> },
    h("div", { class: "strip-color" }),
    h("div", { class: "strip-header" }, h("span", { class: "strip-index", text: "M" }), h("span", { class: "strip-name", text: "Master" })),
    h("div", { class: "strip-kind", text: "Stereo Out" }),
    insertList,
    h("div", { class: "strip-pan" }, pan.element),
    h("div", { class: "strip-route master-route", text: "WASAPI Output" }),
    h("div", { class: "strip-fader-row" }, fader.element),
    h("div", { class: "strip-buttons" }, limiter),
  );
}

function applySelection(): void {
  if (!stripsHost) return;
  for (const strip of stripsHost.querySelectorAll<HTMLElement>(".strip")) {
    strip.classList.toggle("is-selected", strip.dataset.trackId === state.selection.trackId);
  }
}

function updateMeters(): void {
  const transport = state.transport;
  if (!transport) return;
  for (const track of state.project.tracks) {
    const peak = transport.meters.find((entry) => entry.trackId === track.id)?.peak ?? 0;
    faders.get(track.id)?.setPeak(peak);
  }
  faders.get("master")?.setPeak(transport.masterPeak);
}

export function mixerDbLabel(db: number): string {
  return formatDb(db);
}
