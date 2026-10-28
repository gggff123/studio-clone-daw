import { h } from "../utils/dom";
import { icon } from "./icons";

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  danger?: boolean;
}

let activeMenu: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let activeOpenedByHover = false;

/**
 * The menu uses one set of permanent global listeners. The previous version
 * attached listeners from a zero-delay timer, so a menu that closed quickly
 * could leave a stale pointerdown handler behind. After enough menu opens,
 * those stale handlers would close a new menu before its item could be
 * clicked, which made File/Edit look permanently disabled.
 */
export function closeMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
  if (activeAnchor) {
    activeAnchor.classList.remove("is-open");
    activeAnchor.setAttribute("aria-expanded", "false");
  }
  activeAnchor = null;
  activeOpenedByHover = false;
}

function buildMenu(items: MenuItem[]): HTMLElement {
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.separator) {
      menu.append(h("div", { class: "menu-separator" }));
      continue;
    }
    const entry = h(
      "button",
      {
        class: `menu-item ${item.disabled ? "is-disabled" : ""} ${item.danger ? "is-danger" : ""}`.trim(),
        type: "button",
        role: "menuitem",
        disabled: item.disabled ?? false,
        onClick: (event: MouseEvent) => {
          event.stopPropagation();
          if (item.disabled) return;
          closeMenu();
          item.action?.();
        },
      },
      h("span", { class: "menu-check" }, item.checked ? icon("check", 12) : null),
      h("span", { class: "menu-label", text: item.label ?? "" }),
      item.shortcut ? h("span", { class: "menu-shortcut", text: item.shortcut }) : null,
    );
    menu.append(entry);
  }
  return menu;
}

function placeMenu(menu: HTMLElement, x: number, y: number, minWidth = 220): void {
  menu.style.minWidth = `${minWidth}px`;
  document.body.append(menu);
  activeMenu = menu;
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 6;
  const maxY = window.innerHeight - rect.height - 6;
  menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
}

export function openMenuAt(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  placeMenu(buildMenu(items), x, y);
}

export function openMenuFor(
  anchor: HTMLElement,
  items: MenuItem[],
  minWidth = 220,
  byHover = false,
): void {
  closeMenu();
  const rect = anchor.getBoundingClientRect();
  placeMenu(buildMenu(items), rect.left, rect.bottom + 3, minWidth);
  activeAnchor = anchor;
  activeOpenedByHover = byHover;
  anchor.classList.add("is-open");
  anchor.setAttribute("aria-expanded", "true");
}

export function openContextMenu(event: MouseEvent, items: MenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();
  openMenuAt(event.clientX, event.clientY, items);
}

function focusMenuItem(direction: 1 | -1): void {
  if (!activeMenu) return;
  const items = [...activeMenu.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    current === -1
      ? direction === 1
        ? 0
        : items.length - 1
      : (current + direction + items.length) % items.length;
  items[next].focus();
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!activeMenu) return;
    const target = event.target as Node;
    if (activeMenu.contains(target)) return;
    // Let the anchor's click handler toggle the menu closed.
    if (activeAnchor?.contains(target)) return;
    closeMenu();
  },
  true,
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!activeMenu) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const anchor = activeAnchor;
      closeMenu();
      anchor?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      focusMenuItem(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      focusMenuItem(-1);
    }
  },
  true,
);

window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

export function menuButton(
  label: string,
  items: () => MenuItem[],
  className = "",
): HTMLButtonElement {
  const button = h("button", {
    class: `menu-btn ${className}`.trim(),
    type: "button",
    text: label,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    // A hover switch opens the menu before the click arrives. In that case
    // keep the menu open instead of treating the click as a toggle-off.
    if (activeAnchor === button && !activeOpenedByHover) {
      closeMenu();
      return;
    }
    openMenuFor(button, items());
  });
  button.addEventListener("pointerenter", () => {
    // Once a menu is open, hovering a sibling menu button switches to it.
    if (!activeMenu || activeAnchor === button) return;
    openMenuFor(button, items(), 220, true);
  });
  return button;
}
