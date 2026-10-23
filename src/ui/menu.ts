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
let cleanup: (() => void) | null = null;

export function closeMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
  cleanup?.();
  cleanup = null;
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
  const onPointer = (event: PointerEvent): void => {
    if (activeMenu && !activeMenu.contains(event.target as Node)) closeMenu();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeMenu();
  };
  window.setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu, { once: true });
  cleanup = () => {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

export function openMenuFor(anchor: HTMLElement, items: MenuItem[], minWidth = 220): void {
  const rect = anchor.getBoundingClientRect();
  openMenuAt(rect.left, rect.bottom + 3, items);
  anchor.classList.add("is-open");
  const originalCleanup = cleanup;
  cleanup = () => {
    anchor.classList.remove("is-open");
    originalCleanup?.();
  };
}

export function openContextMenu(event: MouseEvent, items: MenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();
  openMenuAt(event.clientX, event.clientY, items);
}

export function menuButton(
  label: string,
  items: () => MenuItem[],
  className = "",
): HTMLButtonElement {
  const button = h("button", {
    class: `menu-btn ${className}`.trim(),
    type: "button",
    text: label,
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.classList.contains("is-open")) {
      closeMenu();
      return;
    }
    openMenuFor(button, items());
  });
  button.addEventListener("pointerenter", () => {
    // Once a menu is open, hovering a sibling menu button switches to it.
    if (!activeMenu) return;
    const rect = button.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 3, items());
    button.classList.add("is-open");
  });
  return button;
}
