import type { EffectKind, InsertEffect } from "../types";

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: string;
  decimals?: number;
  options?: Array<{ value: number; label: string }>;
}

export interface EffectDef {
  kind: EffectKind;
  name: string;
  short: string;
  description: string;
  params: ParamDef[];
}

export const EFFECT_DEFS: EffectDef[] = [
  {
    kind: "gain",
    name: "Studio Gain",
    short: "Gain",
    description: "Utility gain stage with up to +24 dB.",
    params: [
      { key: "gainDb", label: "Gain", min: -60, max: 24, step: 0.1, default: 0, unit: "dB", decimals: 1 },
    ],
  },
  {
    kind: "pan",
    name: "Stereo Pan",
    short: "Pan",
    description: "Constant-power stereo balance.",
    params: [
      { key: "pan", label: "Pan", min: -1, max: 1, step: 0.01, default: 0, unit: "", decimals: 2 },
    ],
  },
  {
    kind: "eq3",
    name: "Studio EQ 3",
    short: "EQ",
    description: "Low shelf, mid peak and high shelf equalizer.",
    params: [
      { key: "lowDb", label: "Low", min: -18, max: 18, step: 0.1, default: 0, unit: "dB", decimals: 1 },
      { key: "midDb", label: "Mid", min: -18, max: 18, step: 0.1, default: 0, unit: "dB", decimals: 1 },
      { key: "highDb", label: "High", min: -18, max: 18, step: 0.1, default: 0, unit: "dB", decimals: 1 },
      { key: "midFreq", label: "Mid Freq", min: 100, max: 12000, step: 10, default: 1000, unit: "Hz", decimals: 0 },
    ],
  },
  {
    kind: "parametric",
    name: "Frequency EQ",
    short: "Freq EQ",
    description: "Single fully parametric bell band.",
    params: [
      { key: "freq", label: "Frequency", min: 30, max: 18000, step: 10, default: 1000, unit: "Hz", decimals: 0 },
      { key: "gainDb", label: "Gain", min: -18, max: 18, step: 0.1, default: 0, unit: "dB", decimals: 1 },
      { key: "q", label: "Q", min: 0.1, max: 12, step: 0.05, default: 1, unit: "", decimals: 2 },
    ],
  },
  {
    kind: "compressor",
    name: "Compressor",
    short: "Comp",
    description: "Feed-forward stereo compressor with makeup gain.",
    params: [
      { key: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, default: -18, unit: "dB", decimals: 1 },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, default: 4, unit: ":1", decimals: 1 },
      { key: "attack", label: "Attack", min: 0.1, max: 200, step: 0.1, default: 10, unit: "ms", decimals: 1 },
      { key: "release", label: "Release", min: 5, max: 2000, step: 1, default: 120, unit: "ms", decimals: 0 },
      { key: "makeup", label: "Makeup", min: 0, max: 24, step: 0.1, default: 0, unit: "dB", decimals: 1 },
    ],
  },
  {
    kind: "limiter",
    name: "Brickwall Limiter",
    short: "Limiter",
    description: "Peak limiter with adjustable ceiling.",
    params: [
      { key: "threshold", label: "Ceiling", min: -24, max: 0, step: 0.1, default: -0.3, unit: "dB", decimals: 1 },
      { key: "release", label: "Release", min: 5, max: 1000, step: 1, default: 80, unit: "ms", decimals: 0 },
    ],
  },
  {
    kind: "noise-gate",
    name: "Noise Gate",
    short: "Gate",
    description: "Downward expander for removing background noise.",
    params: [
      { key: "threshold", label: "Threshold", min: -90, max: -6, step: 0.5, default: -55, unit: "dB", decimals: 1 },
      { key: "attack", label: "Attack", min: 0.1, max: 100, step: 0.1, default: 2, unit: "ms", decimals: 1 },
      { key: "release", label: "Release", min: 5, max: 1000, step: 1, default: 100, unit: "ms", decimals: 0 },
    ],
  },
  {
    kind: "delay",
    name: "Stereo Delay",
    short: "Delay",
    description: "Tempo-independent stereo delay with ping-pong mode.",
    params: [
      { key: "timeMs", label: "Time", min: 1, max: 2000, step: 1, default: 350, unit: "ms", decimals: 0 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01, default: 0.35, unit: "", decimals: 2 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.25, unit: "", decimals: 2 },
      {
        key: "pingPong",
        label: "Ping-Pong",
        min: 0,
        max: 1,
        step: 1,
        default: 0,
        unit: "",
        options: [
          { value: 0, label: "Stereo" },
          { value: 1, label: "Ping-Pong" },
        ],
      },
    ],
  },
  {
    kind: "reverb",
    name: "Studio Reverb",
    short: "Reverb",
    description: "Algorithmic room reverb with damping.",
    params: [
      { key: "size", label: "Size", min: 0, max: 1, step: 0.01, default: 0.55, unit: "", decimals: 2 },
      { key: "damp", label: "Damping", min: 0, max: 1, step: 0.01, default: 0.35, unit: "", decimals: 2 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.22, unit: "", decimals: 2 },
    ],
  },
  {
    kind: "chorus",
    name: "Stereo Chorus",
    short: "Chorus",
    description: "Modulated short delay for width and movement.",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 8, step: 0.05, default: 0.8, unit: "Hz", decimals: 2 },
      { key: "depthMs", label: "Depth", min: 0, max: 12, step: 0.1, default: 4, unit: "ms", decimals: 1 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, default: 0.35, unit: "", decimals: 2 },
    ],
  },
];

export function effectDef(kind: EffectKind): EffectDef {
  return EFFECT_DEFS.find((entry) => entry.kind === kind) ?? EFFECT_DEFS[0];
}

export function defaultParams(kind: EffectKind): Record<string, number> {
  const params: Record<string, number> = {};
  for (const param of effectDef(kind).params) params[param.key] = param.default;
  return params;
}

export function createInsert(kind: EffectKind, id: string): InsertEffect {
  return { id, kind, enabled: true, params: defaultParams(kind) };
}

export function formatParam(param: ParamDef, value: number): string {
  const option = param.options?.find((entry) => entry.value === value);
  if (option) return option.label;
  const decimals = param.decimals ?? 1;
  if (param.unit === "Hz" && value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} kHz`;
  }
  const rendered = value.toFixed(decimals);
  return param.unit ? `${rendered} ${param.unit}` : rendered;
}

export const EFFECT_MENU: Array<{ kind: EffectKind; name: string }> = EFFECT_DEFS.map((def) => ({
  kind: def.kind,
  name: def.name,
}));
