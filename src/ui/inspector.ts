import * as actions from "../actions";
import { state, store } from "../store";
import type { AudioClip, InsertEffect, MidiPart, Track } from "../types";
import { h } from "../utils/dom";
import {
  barTicks,
  clamp,
  formatBarsBeats,
  formatDb,
  projectEndTicks,
} from "../utils/format";
import {
  iconButton,
  rangeControl,
  selectBox,
  sectionHeader,
} from "./controls";
import { EFFECT_MENU, effectDef } from "./effects";
import { icon } from "./icons";
import { openMenuFor } from "./menu";

let host: HTMLElement;

export function mountInspector(element: HTMLElement): void {
  host = element;
  host.classList.add("inspector");
  store.on("project", render);
  store.on("selection", render);
  render();
}

function render(): void {
  if (!host) return;
  const scrollTop = host.scrollTop;
  host.replaceChildren();
  const track = actions.selectedTrack();
  if (!track) {
    host.append(buildProjectInspector());
  } else {
    host.append(buildTrackInspector(track));
    const clip = state.selection.clipId
      ? track.clips.find((entry) => entry.id === state.selection.clipId)
      : null;
    const part = state.selection.partId
      ? track.parts.find((entry) => entry.id === state.selection.partId)
      : null;
    if (clip) host.append(buildClipInspector(track, clip));
    if (part) host.append(buildPartInspector(track, part));
    host.append(buildTrackBottomSections(track));
  }
  host.append(buildMediaWarnings());
  host.scrollTop = scrollTop;
}

function buildTrackInspector(track: Track): HTMLElement {
  const typeLabel =
    track.kind === "audio"
      ? "Audio Track"
      : track.kind === "instrument"
        ? "Instrument Track"
        : track.kind === "midi"
          ? "MIDI Track"
          : track.kind === "group"
            ? "Group Channel"
            : "FX Channel";

  const name = h("input", {
    class: "name-input",
    type: "text",
    value: track.name,
    spellcheck: false,
    title: "Track name",
    onChange: () => {
      const value = name.value.trim();
      if (value) actions.renameTrack(track.id, value);
      else name.value = track.name;
    },
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter") name.blur();
      event.stopPropagation();
    },
  });

  const colorRow = h("div", { class: "color-row" });
  for (const color of ["#4f8fce", "#67c07a", "#c9a227", "#c97a4f", "#a56fce", "#4fc0b7", "#ce4f7a", "#8a9a5b"]) {
    colorRow.append(
      h("button", {
        class: `color-swatch ${track.color === color ? "is-active" : ""}`,
        type: "button",
        style: { background: color },
        title: "Set track color",
        onClick: () => actions.setTrackColor(track.id, color),
      }),
    );
  }

  const volume = rangeControl({
    value: track.volumeDb,
    min: -96,
    max: 12,
    step: 0.1,
    label: "Volume",
    format: (value) => `${formatDb(value)} dB`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setTrackVolume(track.id, value, true),
    onEnd: () => actions.endGesture("project"),
  });
  const pan = rangeControl({
    value: track.pan,
    min: -1,
    max: 1,
    step: 0.01,
    label: "Pan",
    format: (value) =>
      Math.abs(value) < 0.01 ? "C" : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setTrackPan(track.id, value, true),
    onEnd: () => actions.endGesture("project"),
  });

  const mute = toggle("Mute", track.mute, () => actions.toggleMute(track.id), "mute");
  const solo = toggle("Solo", track.solo, () => actions.toggleSolo(track.id), "solo");
  const rec = toggle("Record", track.recordArm, () => actions.toggleRecordArm(track.id), "record");

  const outputOptions = [
    { label: "Master", value: "master" },
    ...state.project.tracks
      .filter((entry) => entry.id !== track.id && (entry.kind === "group" || entry.kind === "fx"))
      .map((entry) => ({ label: entry.name, value: entry.id })),
  ];

  const section = h(
    "div",
    { class: "inspector-section" },
    h("div", { class: "inspector-heading" }, h("span", { class: "track-type", text: typeLabel })),
    name,
    colorRow,
    h("div", { class: "msr-row" }, mute, solo, rec),
    volume.element,
    pan.element,
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Output" }),
      selectBox(outputOptions, track.output, (value) => actions.setTrackOutput(track.id, value)),
    ),
    track.kind === "audio"
      ? h(
          "div",
          { class: "field-row" },
          h("label", { class: "field-label", text: "Input" }),
          h("span", { class: "field-value", text: track.input || "Stereo In" }),
        )
      : null,
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Height" }),
      h("span", { class: "field-value", text: `${track.height} px` }),
    ),
  );

  const wrapper = h(
    "div",
    { class: "track-inspector" },
    h("div", { class: "inspector-track-title" },
      h("span", { class: "inspector-color", style: { background: track.color } }),
      h("span", { text: track.name }),
    ),
    section,
  );

  if (track.instrument) wrapper.append(buildInstrumentSection(track));
  wrapper.append(buildInsertsSection(track.id, track.inserts));
  wrapper.append(buildSendsSection());
  return wrapper;
}

function toggle(label: string, active: boolean, onClick: () => void, kind: string): HTMLElement {
  return h(
    "button",
    {
      class: `msr-btn ${kind} ${active ? "is-active" : ""}`.trim(),
      type: "button",
      text: label,
      onClick,
    },
  );
}

function buildInstrumentSection(track: Track): HTMLElement {
  const inst = track.instrument!;
  const preset = selectBox(
    [
      ...actions.INSTRUMENT_PRESETS.map((entry) => ({ value: entry.name, label: entry.name })),
      ...(actions.INSTRUMENT_PRESETS.some((entry) => entry.name === inst.preset)
        ? []
        : [{ value: inst.preset, label: inst.preset }]),
    ],
    inst.preset,
    (value) => actions.applyInstrumentPreset(track.id, value),
  );

  const waves = [
    { value: "sine", label: "Sine" },
    { value: "triangle", label: "Triangle" },
    { value: "saw", label: "Saw" },
    { value: "square", label: "Square" },
    { value: "noise", label: "Noise" },
  ];

  const wave1 = selectBox(waves, inst.wave1, (value) =>
    actions.setInstrument(track.id, { wave1: value, preset: "Custom" }),
  );
  const wave2 = selectBox(waves, inst.wave2, (value) =>
    actions.setInstrument(track.id, { wave2: value, preset: "Custom" }),
  );

  const param = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    key: keyof typeof inst,
  ): HTMLElement =>
    rangeControl({
      value,
      min,
      max,
      step,
      label,
      format: (next) => `${next.toFixed(step < 0.01 ? 3 : 2)}${unit ? ` ${unit}` : ""}`,
      className: "instrument-param",
      onStart: () => actions.beginGesture(),
      onPreview: (next) =>
        actions.setInstrument(
          track.id,
          { [key]: next, preset: "Custom" } as Partial<typeof inst>,
          true,
        ),
      onEnd: () => actions.endGesture("project"),
    }).element;

  return h(
    "div",
    { class: "inspector-section instrument-section" },
    sectionHeader("Instrument", h("span", { class: "section-badge", text: "Native" })),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Preset" }),
      preset,
    ),
    h(
      "div",
      { class: "wave-grid" },
      h("label", { class: "small-label", text: "Osc 1" }),
      wave1,
      h("label", { class: "small-label", text: "Osc 2" }),
      wave2,
    ),
    param("Detune", inst.detuneCents, -50, 50, 1, "ct", "detuneCents"),
    param("Osc Mix", inst.oscMix, 0, 1, 0.01, "", "oscMix"),
    h("div", { class: "param-group-title", text: "Envelope" }),
    param("Attack", inst.attack, 0.001, 4, 0.001, "s", "attack"),
    param("Decay", inst.decay, 0.001, 4, 0.001, "s", "decay"),
    param("Sustain", inst.sustain, 0, 1, 0.01, "", "sustain"),
    param("Release", inst.release, 0.001, 6, 0.001, "s", "release"),
    h("div", { class: "param-group-title", text: "Filter" }),
    param("Cutoff", inst.cutoffHz, 80, 16000, 10, "Hz", "cutoffHz"),
    param("Resonance", inst.resonance, 0, 1, 0.01, "", "resonance"),
    h("div", { class: "param-group-title", text: "LFO" }),
    param("Rate", inst.lfoRateHz, 0, 20, 0.01, "Hz", "lfoRateHz"),
    param("Depth", inst.lfoDepth, 0, 1, 0.01, "", "lfoDepth"),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Target" }),
      selectBox(
        [
          { value: "pitch", label: "Pitch" },
          { value: "filter", label: "Filter" },
          { value: "amplitude", label: "Amplitude" },
        ],
        inst.lfoTarget,
        (value) => actions.setInstrument(track.id, { lfoTarget: value, preset: "Custom" }),
      ),
    ),
    param("Amp Gain", inst.gainDb, -36, 6, 0.1, "dB", "gainDb"),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Voices" }),
      selectBox(
        ["1", "4", "8", "16", "32"].map((value) => ({ value, label: value })),
        String(inst.polyphony),
        (value) => actions.setInstrument(track.id, { polyphony: Number(value), preset: "Custom" }),
      ),
    ),
  );
}

function buildInsertsSection(hostId: string | "master", inserts: InsertEffect[]): HTMLElement {
  const list = h("div", { class: "inserts-inspector-list" });
  inserts.forEach((insert, index) => {
    list.append(buildInsertRow(hostId, insert, index, inserts.length));
  });
  const add = h(
    "button",
    {
      class: "add-insert-btn",
      type: "button",
      onClick: () => {
        openMenuFor(
          add,
          EFFECT_MENU.map((entry) => ({
            label: entry.name,
            action: () => actions.addInsert(hostId, entry.kind),
          })),
          190,
        );
      },
    },
    icon("plus", 11),
    h("span", { text: "Add Insert" }),
  );
  list.append(add);
  return h(
    "div",
    { class: "inspector-section" },
    sectionHeader("Inserts", h("span", { class: "section-badge", text: `${inserts.length}` })),
    list,
  );
}

function buildInsertRow(
  hostId: string | "master",
  insert: InsertEffect,
  index: number,
  total: number,
): HTMLElement {
  const def = effectDef(insert.kind);
  return h(
    "div",
    { class: `insert-inspector-row ${insert.enabled ? "" : "is-bypassed"}`.trim() },
    h("span", { class: "insert-slot-number", text: String(index + 1) }),
    h(
      "button",
      {
        class: "insert-inspector-name",
        type: "button",
        title: def.description,
        onClick: () => actions.openModal("effect", { host: hostId, effectId: insert.id }),
      },
      icon("sliders", 11),
      h("span", { text: def.name }),
    ),
    h(
      "button",
      {
        class: `insert-bypass ${insert.enabled ? "is-active" : ""}`.trim(),
        type: "button",
        title: "Bypass insert",
        onClick: () => actions.toggleInsert(hostId, insert.id),
      },
      icon("power", 10),
    ),
    iconButton("chevronDown", () => actions.moveInsert(hostId, insert.id, 1), {
      title: "Move insert down",
      className: "tiny",
      size: 11,
      disabled: index >= total - 1,
    }),
    iconButton("chevronRight", () => actions.moveInsert(hostId, insert.id, -1), {
      title: "Move insert up",
      className: "tiny",
      size: 11,
      disabled: index === 0,
    }),
    iconButton("close", () => actions.removeInsert(hostId, insert.id), {
      title: "Remove insert",
      className: "tiny",
      size: 10,
    }),
  );
}

function buildSendsSection(): HTMLElement {
  return h(
    "div",
    { class: "inspector-section" },
    sectionHeader("Sends", h("span", { class: "section-badge", text: "Stored" })),
    h("div", {
      class: "hint-block",
      text: "Sends are saved with the project, but this build does not mix send buses yet. Use inserts and group channels for effects routing.",
    }),
  );
}

function buildClipInspector(track: Track, clip: AudioClip): HTMLElement {
  const gain = rangeControl({
    value: clip.gainDb,
    min: -24,
    max: 24,
    step: 0.1,
    label: "Clip Gain",
    format: (value) => `${formatDb(value)} dB`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.updateClip(track.id, clip.id, { gainDb: value }, true),
    onEnd: () => actions.endGesture("project"),
  });
  const fadeMax = Math.max(1, clip.durationTicks / 2);
  const fadeIn = rangeControl({
    value: clip.fadeInTicks,
    min: 0,
    max: fadeMax,
    step: 10,
    label: "Fade In",
    format: (value) => `${(value / 1000).toFixed(2)} s`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.updateClip(track.id, clip.id, { fadeInTicks: value }, true),
    onEnd: () => actions.endGesture("project"),
  });
  const fadeOut = rangeControl({
    value: clip.fadeOutTicks,
    min: 0,
    max: fadeMax,
    step: 10,
    label: "Fade Out",
    format: (value) => `${(value / 1000).toFixed(2)} s`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.updateClip(track.id, clip.id, { fadeOutTicks: value }, true),
    onEnd: () => actions.endGesture("project"),
  });

  return h(
    "div",
    { class: "inspector-section clip-section" },
    sectionHeader("Audio Clip", h("span", { class: "section-badge", text: "Audio" })),
    h(
      "div",
      { class: "field-row" },
      h("span", { class: "field-value strong", text: clip.name }),
    ),
    infoRow("Start", formatBarsBeats(clip.startTicks, state.project.ppq, state.project.timeSignature)),
    infoRow("Length", `${(clip.durationTicks / state.project.ppq).toFixed(2)} beats`),
    infoRow("Source", clip.mediaPath),
    gain.element,
    fadeIn.element,
    fadeOut.element,
    h(
      "div",
      { class: "section-actions" },
      h("button", {
        class: "text-btn",
        type: "button",
        onClick: () => actions.splitClip(track.id, clip.id, state.transport?.positionTicks ?? clip.startTicks),
      }, "Split at Cursor"),
      h("button", {
        class: "text-btn",
        type: "button",
        onClick: () => actions.duplicateClip(track.id, clip.id),
      }, "Duplicate"),
      h("button", {
        class: "text-btn danger",
        type: "button",
        onClick: () => actions.deleteClip(track.id, clip.id),
      }, "Delete"),
    ),
  );
}

function buildPartInspector(track: Track, part: MidiPart): HTMLElement {
  const durationMax = Math.max(part.durationTicks * 2, state.project.ppq * 4);
  const length = rangeControl({
    value: part.durationTicks,
    min: state.project.ppq,
    max: durationMax,
    step: 10,
    label: "Length",
    format: (value) => `${(value / state.project.ppq).toFixed(2)} beats`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.updatePart(track.id, part.id, { durationTicks: value }, true),
    onEnd: () => actions.endGesture("project"),
  });
  return h(
    "div",
    { class: "inspector-section clip-section" },
    sectionHeader("MIDI Part", h("span", { class: "section-badge", text: `${part.notes.length} notes` })),
    h("div", { class: "field-row" }, h("span", { class: "field-value strong", text: part.name })),
    infoRow("Start", formatBarsBeats(part.startTicks, state.project.ppq, state.project.timeSignature)),
    length.element,
    h(
      "div",
      { class: "section-actions" },
      h("button", {
        class: "text-btn primary",
        type: "button",
        onClick: () => actions.selectPart(track.id, part.id, true),
      }, "Open Piano Roll"),
      h("button", {
        class: "text-btn",
        type: "button",
        onClick: () => actions.quantizeNotes(track.id, part.id, state.layout.snapTicks, false),
      }, "Quantize All"),
      h("button", {
        class: "text-btn danger",
        type: "button",
        onClick: () => actions.deletePart(track.id, part.id),
      }, "Delete"),
    ),
  );
}

function buildTrackBottomSections(track: Track): HTMLElement {
  return h(
    "div",
    { class: "inspector-section track-stats" },
    sectionHeader("Track Info"),
    infoRow("Clips", String(track.clips.length)),
    infoRow("MIDI Parts", String(track.parts.length)),
    infoRow("Inserts", String(track.inserts.length)),
    infoRow("Kind", track.kind),
  );
}

function buildProjectInspector(): HTMLElement {
  const project = state.project;
  const transport = state.transport;
  const name = h("input", {
    class: "name-input",
    type: "text",
    value: project.name,
    spellcheck: false,
    onChange: () => {
      const value = name.value.trim();
      if (value) actions.setProjectName(value);
      else name.value = project.name;
    },
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter") name.blur();
      event.stopPropagation();
    },
  });

  const tempo = rangeControl({
    value: project.tempo,
    min: 20,
    max: 300,
    step: 0.5,
    label: "Tempo",
    format: (value) => `${value.toFixed(1)} BPM`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => {
      state.project.tempo = value;
      void apiSeekPreview();
    },
    onEnd: () => {
      actions.endGesture("project");
      actions.scheduleEngineSync(30);
    },
  });

  const cycleStart = barsField(project.loopRegion.startTicks, (ticks) =>
    actions.setLoop(project.loopRegion.enabled, ticks, Math.max(ticks + project.ppq, project.loopRegion.endTicks)),
  );
  const cycleEnd = barsField(project.loopRegion.endTicks, (ticks) =>
    actions.setLoop(project.loopRegion.enabled, Math.min(project.loopRegion.startTicks, ticks - project.ppq), ticks),
  );

  const markers = h("div", { class: "marker-list" });
  if (project.markers.length === 0) markers.append(h("div", { class: "hint-block", text: "No markers." }));
  for (const marker of project.markers) {
    markers.append(
      h(
        "div",
        { class: "marker-row" },
        h("span", { class: "marker-dot", style: { background: marker.color } }),
        h("button", {
          class: "marker-jump",
          type: "button",
          text: marker.name,
          title: "Go to marker",
          onClick: () => void actions.seekTicks(marker.ticks),
        }),
        h("span", { class: "marker-position", text: formatBarsBeats(marker.ticks, project.ppq, project.timeSignature) }),
        iconButton("close", () => actions.removeMarker(marker.id), { title: "Delete marker", size: 10, className: "tiny" }),
      ),
    );
  }

  const masterVolume = rangeControl({
    value: project.master.volumeDb,
    min: -96,
    max: 12,
    step: 0.1,
    label: "Master",
    format: (value) => `${formatDb(value)} dB`,
    onStart: () => actions.beginGesture(),
    onPreview: (value) => actions.setMasterVolume(value, true),
    onEnd: () => actions.endGesture("project"),
  });

  return h(
    "div",
    { class: "project-inspector" },
    h("div", { class: "inspector-heading" }, h("span", { class: "track-type", text: "Project" })),
    name,
    h("div", { class: "project-meta", text: `${project.tracks.length} tracks · ${formatBarsBeats(projectEndTicks(project), project.ppq, project.timeSignature)} end` }),
    sectionHeader("Timeline"),
    tempo.element,
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Signature" }),
      h(
        "div",
        { class: "signature-row" },
        selectBox(
          ["2", "3", "4", "5", "6", "7", "8", "9", "12"].map((value) => ({ value, label: value })),
          String(project.timeSignature.numerator),
          (value) => actions.setTimeSignature(Number(value), project.timeSignature.denominator),
          "sig-num",
        ),
        h("span", { class: "signature-slash", text: "/" }),
        selectBox(
          ["2", "4", "8", "16"].map((value) => ({ value, label: value })),
          String(project.timeSignature.denominator),
          (value) => actions.setTimeSignature(project.timeSignature.numerator, Number(value)),
          "sig-den",
        ),
      ),
    ),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Cycle" }),
      h(
        "button",
        {
          class: `toggle-btn ${project.loopRegion.enabled ? "is-active" : ""}`,
          type: "button",
          text: project.loopRegion.enabled ? "On" : "Off",
          onClick: () => actions.setLoop(!project.loopRegion.enabled),
        },
      ),
    ),
    cycleStart,
    cycleEnd,
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Metronome" }),
      h(
        "button",
        {
          class: `toggle-btn ${project.metronome ? "is-active" : ""}`,
          type: "button",
          text: project.metronome ? "On" : "Off",
          onClick: () => actions.toggleMetronome(),
        },
      ),
    ),
    sectionHeader("Master"),
    masterVolume.element,
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field-label", text: "Limiter" }),
      h(
        "button",
        {
          class: `toggle-btn ${project.master.limiter ? "is-active" : ""}`,
          type: "button",
          text: project.master.limiter ? "On" : "Off",
          onClick: () => actions.setMasterLimiter(!project.master.limiter),
        },
      ),
    ),
    buildInsertsSection("master", project.master.inserts),
    sectionHeader("Markers", h(
      "button",
      {
        class: "section-action",
        type: "button",
        text: "+ Add",
        onClick: () => actions.addMarker(),
      },
    )),
    markers,
    sectionHeader("Audio Engine"),
    infoRow("Output", transport?.outputDevice ?? state.devices?.currentOutput ?? "Not available"),
    infoRow("Device rate", transport ? `${transport.sampleRate} Hz` : `${project.sampleRate} Hz`),
    infoRow("Engine", transport?.engineReady ? "Ready" : "Unavailable"),
    infoRow("Project rate", `${project.sampleRate} Hz`),
    h(
      "div",
      { class: "section-actions" },
      h("button", {
        class: "text-btn",
        type: "button",
        onClick: () => actions.openModal("audio"),
      }, "Audio Connections…"),
      h("button", {
        class: "text-btn",
        type: "button",
        onClick: () => actions.openModal("midi"),
      }, "MIDI Connections…"),
    ),
  );
}

function barsField(ticks: number, commit: (ticks: number) => void): HTMLElement {
  const bar = barTicks(state.project.ppq, state.project.timeSignature);
  const input = h("input", {
    class: "number-input",
    type: "number",
    min: "1",
    step: "1",
    value: String(Math.floor(ticks / bar) + 1),
    title: "Bar number",
  });
  input.addEventListener("change", () => {
    const value = Math.max(1, Number(input.value) || 1);
    commit((value - 1) * bar);
  });
  return h(
    "div",
    { class: "field-row" },
    h("label", { class: "field-label", text: "Bar" }),
    input,
  );
}

function apiSeekPreview(): Promise<void> {
  return Promise.resolve();
}

function infoRow(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "field-row info-row" },
    h("span", { class: "field-label", text: label }),
    h("span", { class: "field-value", text: value, title: value }),
  );
}

function buildMediaWarnings(): HTMLElement {
  const entries: HTMLElement[] = [];
  if (state.missingMedia.length > 0) {
    const list = h("div", { class: "warning-list" });
    for (const missing of state.missingMedia) {
      list.append(
        h(
          "div",
          { class: "warning-row" },
          h("span", { class: "warning-path", text: missing.mediaPath, title: missing.mediaPath }),
          h("button", {
            class: "text-btn tiny danger",
            type: "button",
            text: "Remove",
            onClick: () => actions.deleteClip(missing.trackId, missing.clipId),
          }),
        ),
      );
    }
    entries.push(
      h(
        "div",
        { class: "inspector-section warning-section" },
        sectionHeader("Missing Media", h("span", { class: "section-badge danger", text: String(state.missingMedia.length) })),
        h("div", { class: "hint-block", text: "These clips reference files that could not be found. Re-import the audio or remove the clips." }),
        list,
      ),
    );
  }
  if (state.engineWarnings.length > 0) {
    entries.push(
      h(
        "div",
        { class: "inspector-section warning-section" },
        sectionHeader("Engine Warnings", h("span", { class: "section-badge danger", text: String(state.engineWarnings.length) })),
        ...state.engineWarnings.slice(0, 6).map((warning) =>
          h("div", { class: "warning-row" }, h("span", { class: "warning-path", text: warning })),
        ),
      ),
    );
  }
  return h("div", { class: "warnings" }, ...entries);
}

export function ticksInBars(ticks: number): number {
  return ticks / barTicks(state.project.ppq, state.project.timeSignature);
}

export function clampFade(value: number, duration: number): number {
  return clamp(value, 0, duration / 2);
}
