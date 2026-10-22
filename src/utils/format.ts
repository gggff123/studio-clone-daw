import type { Project, TimeSignature } from "../types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function peakToDb(peak: number): number {
  if (peak <= 0.000_001) return -96;
  return 20 * Math.log10(peak);
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -95.9) return "-∞";
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return "C";
  return `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
}

export function beatTicks(ppq: number, sig: TimeSignature): number {
  return Math.max(1, Math.round((ppq * 4) / Math.max(1, sig.denominator)));
}

export function barTicks(ppq: number, sig: TimeSignature): number {
  return Math.max(1, beatTicks(ppq, sig) * Math.max(1, sig.numerator));
}

export function formatBarsBeats(
  ticks: number,
  ppq: number,
  sig: TimeSignature,
): string {
  const bar = barTicks(ppq, sig);
  const beat = beatTicks(ppq, sig);
  const safe = Math.max(0, Math.round(ticks));
  const barIndex = Math.floor(safe / bar) + 1;
  const inBar = safe % bar;
  const beatIndex = Math.floor(inBar / beat) + 1;
  const inBeat = inBar % beat;
  const sixteenth = Math.floor(inBeat / (beat / 4)) + 1;
  return `${barIndex}.${beatIndex}.${sixteenth}`;
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(
    ms,
  ).padStart(3, "0")}`;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(pitch: number): string {
  const p = clamp(Math.round(pitch), 0, 127);
  // MIDI 60 is middle C, displayed as C3 in the Cubase convention.
  return `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2}`;
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function projectEndTicks(project: Project): number {
  let end = project.loopRegion.endTicks;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.startTicks + clip.durationTicks);
    }
    for (const part of track.parts) {
      end = Math.max(end, part.startTicks + part.durationTicks);
      for (const note of part.notes) {
        end = Math.max(
          end,
          part.startTicks + note.startTicks + note.durationTicks,
        );
      }
    }
  }
  return end;
}

export function projectLengthBars(project: Project): number {
  const perBar = barTicks(project.ppq, project.timeSignature);
  return Math.max(8, Math.ceil(projectEndTicks(project) / perBar) + 8);
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDateFromEpoch(seconds: number): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ticksToPx(ticks: number, pxPerBeat: number, ppq: number): number {
  return (ticks / Math.max(1, ppq)) * pxPerBeat;
}

export function pxToTicks(px: number, pxPerBeat: number, ppq: number): number {
  return (px / Math.max(0.0001, pxPerBeat)) * Math.max(1, ppq);
}

export function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.slice(0, dot) : path;
}
