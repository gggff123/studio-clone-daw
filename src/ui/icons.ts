const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS: Record<string, string> = {
  play: '<path d="M8 5l11 7-11 7V5z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="6" y="5" width="4" height="14" rx="0.6" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="0.6" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
  rewind:
    '<path d="M11 6L4 12l7 6V6z" fill="currentColor" stroke="none"/><path d="M20 6l-7 6 7 6V6z" fill="currentColor" stroke="none"/>',
  forward:
    '<path d="M13 6l7 6-7 6V6z" fill="currentColor" stroke="none"/><path d="M4 6l7 6-7 6V6z" fill="currentColor" stroke="none"/>',
  loop:
    '<path d="M4 9a5 5 0 0 1 5-5h8"/><path d="M17 1.8 20.2 4 17 6.2"/><path d="M20 15a5 5 0 0 1-5 5H7"/><path d="M7 22.2 3.8 20 7 17.8"/>',
  metronome:
    '<path d="M9 4h6l4 16H5L9 4z"/><path d="M12 7v9"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
  undo: '<path d="M8 7H3V2"/><path d="M3 7l4.5-3.2A8 8 0 1 1 4.6 16"/>',
  redo: '<path d="M16 7h5V2"/><path d="M21 7l-4.5-3.2A8 8 0 1 0 19.4 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  file: '<path d="M6 3h8l5 5v13H6V3z"/><path d="M14 3v5h5"/>',
  save: '<path d="M4 4h13l3 3v13H4V4z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/>',
  open: '<path d="M3 7h6l2 2h10l-2 10H3V7z"/><path d="M3 7V5h6l2 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  power: '<path d="M12 3v9"/><path d="M6.2 6.2a8 8 0 1 0 11.6 0"/>',
  wave: '<path d="M2 12h3l2-6 3 13 3-10 2 6 2-3h5"/>',
  keyboard:
    '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 5v9M11 5v9M15 5v9M18 5v9"/><path d="M3 14h18"/>',
  synth:
    '<path d="M3 14c2 0 2-8 4-8s2 12 4 12 2-10 4-10 2 6 4 6h2"/>',
  layers:
    '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>',
  sparkle:
    '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>',
  scissors:
    '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M8 8l12 10M20 6 8 16"/>',
  copy:
    '<rect x="9" y="9" width="11" height="12" rx="1.5"/><path d="M15 5H5v12"/>',
  zoomIn:
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/><path d="M10.5 7.5v6M7.5 10.5h6"/>',
  zoomOut:
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/><path d="M7.5 10.5h6"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  arrowLeft: '<path d="M20 12H4"/><path d="M10 6l-6 6 6 6"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  warning:
    '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  speaker:
    '<path d="M4 9h4l5-4v14l-5-4H4V9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
  mixer:
    '<path d="M5 4v16M12 4v16M19 4v16"/><rect x="3" y="8" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="14" width="4" height="3" rx="1" fill="currentColor"/><rect x="17" y="6" width="4" height="3" rx="1" fill="currentColor"/>',
  music:
    '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  grid:
    '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.5v.4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  eye:
    '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  sliders:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  cursor: '<path d="M5 3l14 8.5-6.4 1.5L10 20 5 3z"/>',
  pencil: '<path d="M4 20l1-5L16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 2z"/><path d="M14 6l4 4"/>',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName | string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? ICONS.file;
  return svg;
}
