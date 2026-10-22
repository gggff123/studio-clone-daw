type Props = Record<string, unknown> & {
  class?: string;
  text?: string;
  html?: string;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Array<Node | string | number | null | undefined>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "class") element.className = String(value);
      else if (key === "text") element.textContent = String(value);
      else if (key === "html") element.innerHTML = String(value);
      else if (key === "dataset") {
        for (const [dataKey, dataValue] of Object.entries(
          value as Record<string, string>,
        )) {
          element.dataset[dataKey] = dataValue;
        }
      } else if (key === "style") {
        for (const [styleKey, styleValue] of Object.entries(
          value as Record<string, string | number>,
        )) {
          if (styleValue === undefined || styleValue === null) continue;
          if (styleKey.startsWith("--")) {
            element.style.setProperty(styleKey, String(styleValue));
          } else {
            (element.style as unknown as Record<string, string>)[styleKey] = String(styleValue);
          }
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(
          key.slice(2).toLowerCase(),
          value as EventListener,
        );
      } else if (key in element) {
        (element as unknown as Record<string, unknown>)[key] = value;
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child);
  }
  return element;
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  element: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  element.addEventListener(type, handler as EventListener, options);
  return () => element.removeEventListener(type, handler as EventListener, options);
}

export function closestTrack(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-track-id]") ?? null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function pointerX(event: PointerEvent): number {
  return event.clientX;
}

export function pxPerTick(pxPerBeat: number, ppq: number): number {
  return pxPerBeat / Math.max(1, ppq);
}

export function ticksToPx(ticks: number, pxPerBeat: number, ppq: number): number {
  return (ticks / Math.max(1, ppq)) * pxPerBeat;
}

export function pxToTicks(px: number, pxPerBeat: number, ppq: number): number {
  return (px / Math.max(0.0001, pxPerBeat)) * Math.max(1, ppq);
}

export function snapToGrid(ticks: number, gridTicks: number): number {
  if (gridTicks <= 0) return Math.max(0, Math.round(ticks));
  return Math.max(0, Math.round(ticks / gridTicks) * gridTicks);
}

export function requestFrame(callback: () => void): void {
  requestAnimationFrame(() => callback());
}

export function debounce<T extends (...args: never[]) => void>(
  callback: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      callback(...args);
    }, wait);
  };
}

export function setVar(element: HTMLElement, name: string, value: string): void {
  element.style.setProperty(name, value);
}
