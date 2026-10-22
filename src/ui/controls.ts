import { icon, type IconName } from "./icons";
import { h } from "../utils/dom";
import { clamp, formatDb, peakToDb } from "../utils/format";

export interface IconButtonOptions {
  title: string;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  size?: number;
}

export function iconButton(
  name: IconName | string,
  onClick: (event: MouseEvent) => void,
  options: IconButtonOptions,
): HTMLButtonElement {
  const button = h("button", {
    class: ["icon-btn", options.className, options.active ? "is-active" : ""]
      .filter(Boolean)
      .join(" "),
    type: "button",
    title: options.title,
    "aria-label": options.title,
    disabled: options.disabled ?? false,
    onClick,
  });
  button.append(icon(name, options.size ?? 14));
  return button;
}

export function textButton(
  label: string,
  onClick: (event: MouseEvent) => void,
  className = "",
): HTMLButtonElement {
  return h(
    "button",
    { class: `text-btn ${className}`.trim(), type: "button", onClick },
    label,
  );
}

export interface RangeOptions {
  value: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
  format?: (value: number) => string;
  className?: string;
  onStart?: () => void;
  onPreview: (value: number) => void;
  onEnd?: () => void;
  showValue?: boolean;
  ariaLabel?: string;
}

export interface RangeControl {
  element: HTMLElement;
  input: HTMLInputElement;
  setValue: (value: number, notify?: boolean) => void;
}

export function rangeControl(options: RangeOptions): RangeControl {
  const step = options.step ?? 0.01;
  const input = h("input", {
    type: "range",
    min: String(options.min),
    max: String(options.max),
    step: String(step),
    value: String(options.value),
    class: "range-input",
    "aria-label": options.ariaLabel ?? options.label ?? "Value",
  });
  const value = h("span", {
    class: "param-value",
    text: options.format ? options.format(options.value) : options.value.toFixed(2),
  });
  let gesture = false;
  const setValue = (next: number, notify = false): void => {
    const clamped = clamp(next, options.min, options.max);
    input.value = String(clamped);
    value.textContent = options.format ? options.format(clamped) : String(clamped);
    if (notify) options.onPreview(clamped);
  };
  input.addEventListener("pointerdown", () => {
    if (gesture) return;
    gesture = true;
    options.onStart?.();
  });
  input.addEventListener("input", () => {
    const next = Number(input.value);
    if (!gesture) {
      gesture = true;
      options.onStart?.();
    }
    options.onPreview(next);
    value.textContent = options.format ? options.format(next) : String(next);
  });
  const finish = (): void => {
    if (!gesture) return;
    gesture = false;
    options.onEnd?.();
  };
  input.addEventListener("change", finish);
  input.addEventListener("pointerup", finish);
  input.addEventListener("pointercancel", finish);
  input.addEventListener("blur", finish);

  const element = h(
    "div",
    { class: `param-row ${options.className ?? ""}`.trim() },
    options.label ? h("label", { class: "param-label", text: options.label }) : null,
    input,
    options.showValue === false ? null : value,
  );
  return { element, input, setValue };
}

export interface FaderOptions {
  valueDb: number;
  minDb?: number;
  maxDb?: number;
  height?: number;
  onStart?: () => void;
  onPreview: (db: number) => void;
  onEnd?: () => void;
}

const FADER_MIN = -96;
const FADER_BREAK = -60;

function dbToPosition(db: number): number {
  const value = clamp(db, FADER_MIN, 12);
  if (value <= FADER_BREAK) {
    return ((value - FADER_MIN) / (FADER_BREAK - FADER_MIN)) * 0.24;
  }
  return 0.24 + ((value - FADER_BREAK) / 72) * 0.76;
}

function positionToDb(position: number): number {
  const value = clamp(position, 0, 1);
  if (value <= 0.24) {
    return FADER_MIN + (value / 0.24) * (FADER_BREAK - FADER_MIN);
  }
  return FADER_BREAK + ((value - 0.24) / 0.76) * 72;
}

export interface FaderControl {
  element: HTMLElement;
  setDb: (db: number) => void;
  setPeak: (peak: number) => void;
}

export function verticalFader(options: FaderOptions): FaderControl {
  const dbLabel = h("div", { class: "fader-db", text: formatDb(options.valueDb) });
  const cap = h("div", { class: "fader-cap" });
  const fill = h("div", { class: "fader-fill" });
  const track = h("div", { class: "fader-track" }, fill, cap);
  const meterFill = h("div", { class: "meter-fill" });
  const meterPeak = h("div", { class: "meter-peak" });
  const meter = h("div", { class: "meter", title: "Peak meter" }, meterFill, meterPeak);
  const element = h(
    "div",
    {
      class: "fader",
      style: {
        height: `${options.height ?? 168}px`,
      },
    },
    track,
    meter,
    dbLabel,
  );
  let current = options.valueDb;
  let peakHold = 0;
  let peakHoldTime = 0;
  let dragging = false;

  const paint = (): void => {
    const position = dbToPosition(current);
    cap.style.bottom = `calc(${position * 100}% - 5px)`;
    fill.style.height = `${position * 100}%`;
    dbLabel.textContent = formatDb(current);
    element.title = `${formatDb(current)} dB`;
  };
  paint();

  const setDb = (db: number): void => {
    current = clamp(db, options.minDb ?? -96, options.maxDb ?? 12);
    paint();
  };

  const setPeak = (peak: number): void => {
    const db = peakToDb(peak);
    const normalized = clamp((db + 60) / 60, 0, 1);
    meterFill.style.height = `${normalized * 100}%`;
    const now = performance.now();
    if (normalized >= peakHold) {
      peakHold = normalized;
      peakHoldTime = now;
    } else if (now - peakHoldTime > 900) {
      peakHold = Math.max(normalized, peakHold - 0.01);
    }
    meterPeak.style.bottom = `${clamp(peakHold, 0, 1) * 100}%`;
    meter.classList.toggle("is-hot", normalized > 0.95);
  };

  const updateFromPointer = (event: PointerEvent): void => {
    const rect = track.getBoundingClientRect();
    const position = 1 - (event.clientY - rect.top) / Math.max(1, rect.height);
    const next = positionToDb(position);
    const stepped = Math.round(next * 10) / 10;
    if (stepped === current) return;
    setDb(stepped);
    options.onPreview(stepped);
  };

  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    track.setPointerCapture(event.pointerId);
    options.onStart?.();
    updateFromPointer(event);
  });
  track.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    updateFromPointer(event);
  });
  const end = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    options.onEnd?.();
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("dblclick", () => {
    options.onStart?.();
    setDb(0);
    options.onPreview(0);
    options.onEnd?.();
  });

  return { element, setDb, setPeak };
}

export function toggleButton(
  label: string,
  active: boolean,
  onClick: () => void,
  title?: string,
  className = "",
): HTMLButtonElement {
  return h(
    "button",
    {
      class: `toggle-btn ${className} ${active ? "is-active" : ""}`.trim(),
      type: "button",
      title: title ?? label,
      onClick,
    },
    label,
  );
}

export function selectBox(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
  className = "",
): HTMLSelectElement {
  const select = h("select", { class: `select-box ${className}`.trim() });
  for (const option of options) {
    select.append(
      h("option", { value: option.value, text: option.label, selected: option.value === value }),
    );
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function sectionHeader(
  title: string,
  action?: HTMLElement,
  open = true,
): HTMLElement {
  const header = h(
    "div",
    { class: "section-header" },
    h("span", { class: "section-title", text: title }),
    action ?? null,
  );
  if (open) header.classList.add("is-open");
  return header;
}

export function emptyState(title: string, detail?: string): HTMLElement {
  return h(
    "div",
    { class: "empty-state" },
    h("div", { class: "empty-title", text: title }),
    detail ? h("div", { class: "empty-detail", text: detail }) : null,
  );
}

export function inlineRename(
  initial: string,
  commit: (value: string) => void,
): HTMLInputElement {
  const input = h("input", {
    class: "inline-rename",
    type: "text",
    value: initial,
    spellcheck: false,
  });
  let done = false;
  const finish = (accept: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(h("span", { class: "inline-rename-text", text: accept && value ? value : initial }));
    if (accept && value && value !== initial) commit(value);
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
    event.stopPropagation();
  });
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

export function makeDraggableNumber(
  element: HTMLElement,
  options: {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
    sensitivity?: number;
  },
): void {
  let dragging = false;
  let startY = 0;
  let startValue = options.value;
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    startY = event.clientY;
    startValue = options.value;
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const delta = (startY - event.clientY) * (options.sensitivity ?? 1);
    const next = clamp(startValue + delta, options.min, options.max);
    options.onChange(Math.round(next));
  });
  const end = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
}
