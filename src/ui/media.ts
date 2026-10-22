import * as actions from "../actions";
import { api, fileDialog } from "../api";
import { state } from "../store";
import type { MediaEntry } from "../types";
import { h } from "../utils/dom";
import {
  fileStem,
  formatBytes,
  formatDateFromEpoch,
} from "../utils/format";
import { iconButton } from "./controls";
import { icon } from "./icons";
import { openContextMenu, type MenuItem } from "./menu";

let host: HTMLElement;
let toolbar: HTMLElement;
let breadcrumb: HTMLElement;
let listEl: HTMLElement;
let statusEl: HTMLElement;
let searchInput: HTMLInputElement;

let currentDir = "";
let entries: MediaEntry[] = [];
let filter = "";
let selectedPath: string | null = null;
let error: string | null = null;
let loading = false;

export function mountMedia(element: HTMLElement): void {
  host = element;
  host.classList.add("media-browser");

  toolbar = h("div", { class: "media-toolbar" });
  breadcrumb = h("div", { class: "media-breadcrumb", title: "Current folder" });
  listEl = h("div", { class: "media-list" });
  statusEl = h("div", { class: "media-status" });
  searchInput = h("input", {
    class: "media-search",
    type: "search",
    placeholder: "Filter files…",
    spellcheck: false,
    onInput: () => {
      filter = searchInput.value.trim().toLowerCase();
      renderList();
    },
    onKeydown: (event: KeyboardEvent) => event.stopPropagation(),
  });

  toolbar.append(
    iconButton("arrowLeft", () => void navigateUp(), { title: "Parent folder", size: 13 }),
    iconButton("folder", () => void chooseFolder(), { title: "Choose folder", size: 13 }),
    iconButton("rewind", () => void navigateHome(), { title: "Home folder", size: 13 }),
    iconButton("undo", () => void refresh(), { title: "Refresh", size: 13 }),
    h("div", { class: "toolbar-spacer" }),
    iconButton("plus", () => void actions.importAudioFile(), { title: "Import audio file", size: 13 }),
    iconButton("music", () => void actions.importMidiFile(), { title: "Import MIDI file", size: 13 }),
  );

  host.append(
    toolbar,
    breadcrumb,
    h("div", { class: "media-search-row" }, searchInput,
      state.projectPath
        ? h("button", {
            class: "text-btn tiny",
            type: "button",
            text: "Project Media",
            title: "Browse the project media folder",
            onClick: () => void navigateTo(projectMediaDir()),
          })
        : null,
    ),
    listEl,
    statusEl,
  );

  void navigateHome();
}

function projectMediaDir(): string {
  if (!state.projectPath) return "";
  return `${state.projectPath.slice(0, state.projectPath.lastIndexOf("."))}.media`;
}

async function navigateHome(): Promise<void> {
  try {
    const dir = await api.defaultMediaDir();
    if (dir) await navigateTo(dir);
    else {
      error = "No default media folder is available. Choose a folder.";
      renderList();
    }
  } catch (err) {
    error = String(err);
    renderList();
  }
}

async function chooseFolder(): Promise<void> {
  const dir = await fileDialog.pickFolder("Choose Media Folder");
  if (dir) await navigateTo(dir);
}

async function navigateUp(): Promise<void> {
  if (!currentDir) return;
  const trimmed = currentDir.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index <= 2) {
    if (/^[A-Za-z]:/.test(trimmed)) await navigateTo(`${trimmed.slice(0, 2)}\\`);
    return;
  }
  await navigateTo(trimmed.slice(0, index));
}

async function navigateTo(dir: string): Promise<void> {
  if (!dir) return;
  loading = true;
  error = null;
  selectedPath = null;
  renderAll();
  try {
    entries = await api.listMedia(dir);
    currentDir = dir;
    renderAll();
  } catch (err) {
    error = String(err);
    loading = false;
    renderAll();
  }
}

async function refresh(): Promise<void> {
  if (currentDir) await navigateTo(currentDir);
}

function renderAll(): void {
  renderToolbar();
  renderList();
}

function renderToolbar(): void {
  breadcrumb.replaceChildren();
  const parts = currentDir.split(/[\\/]/).filter(Boolean);
  parts.forEach((part, index) => {
    if (index > 0) breadcrumb.append(h("span", { class: "crumb-sep", text: "›" }));
    breadcrumb.append(
      h("button", {
        class: "crumb",
        type: "button",
        text: part,
        title: currentDir,
        onClick: () => {
          const prefix = currentDir.startsWith("\\\\") ? "\\\\" : "";
          const root = currentDir.match(/^[A-Za-z]:/)?.[0];
          const accum: string[] = [];
          if (prefix) accum.push("");
          if (root) accum.push(root);
          for (let i = 0; i <= index; i += 1) accum.push(parts[i]);
          const joined = accum.join("\\").replace(/^\\\\(?=[A-Za-z])/, "\\\\");
          void navigateTo(joined);
        },
      }),
    );
  });
  if (!currentDir) breadcrumb.append(h("span", { class: "crumb dim", text: "No folder selected" }));
}

function renderList(): void {
  listEl.replaceChildren();
  if (loading) {
    listEl.append(h("div", { class: "media-empty", text: "Reading folder…" }));
    statusEl.textContent = "";
    return;
  }
  if (error) {
    listEl.append(h("div", { class: "media-empty error", text: error }));
    statusEl.textContent = currentDir;
    return;
  }
  const filtered = entries.filter((entry) =>
    filter ? entry.name.toLowerCase().includes(filter) : true,
  );
  if (filtered.length === 0) {
    listEl.append(
      h("div", {
        class: "media-empty",
        text: filter ? "No files match the filter." : "This folder is empty.",
      }),
    );
  }
  for (const entry of filtered) {
    listEl.append(buildRow(entry));
  }
  statusEl.replaceChildren(
    h("span", { text: `${filtered.length} item(s)` }),
    ...(currentDir
      ? [h("span", { class: "media-path", text: currentDir, title: currentDir })]
      : []),
  );
}

function rowIcon(entry: MediaEntry): string {
  if (entry.isDir) return "folder";
  if (entry.kind === "audio") return "wave";
  if (entry.kind === "midi") return "music";
  if (entry.kind === "project") return "save";
  if (entry.kind === "preset") return "sliders";
  return "file";
}

function buildRow(entry: MediaEntry): HTMLElement {
  const row = h(
    "div",
    {
      class: `media-row ${selectedPath === entry.path ? "is-selected" : ""} ${entry.isDir ? "is-dir" : ""}`.trim(),
      title: entry.path,
      onClick: () => {
        selectedPath = entry.path;
        for (const node of listEl.querySelectorAll(".media-row")) node.classList.remove("is-selected");
        row.classList.add("is-selected");
      },
      onDblclick: () => void activate(entry),
    },
    h("span", { class: `media-kind kind-${entry.kind}` }, icon(rowIcon(entry), 13)),
    h(
      "span",
      { class: "media-name" },
      h("span", { class: "media-name-text", text: entry.name }),
      h("span", { class: "media-sub", text: subtitle(entry) }),
    ),
    h("span", { class: "media-size", text: entry.isDir ? "Folder" : formatBytes(entry.size) }),
    h("span", { class: "media-date", text: entry.modifiedSeconds ? formatDateFromEpoch(entry.modifiedSeconds) : "" }),
    entry.kind === "audio" || entry.kind === "midi"
      ? iconButton(
          "plus",
          (event: MouseEvent) => {
            event.stopPropagation();
            if (entry.kind === "audio") void actions.importAudioFile(entry.path);
            else void actions.importMidiFile(entry.path);
          },
          { title: "Import into project", className: "media-import", size: 12 },
        )
      : h("span", { class: "media-import-spacer" }),
  );

  row.addEventListener("contextmenu", (event) => {
    selectedPath = entry.path;
    const items: MenuItem[] = [];
    if (entry.isDir) {
      items.push({ label: "Open Folder", action: () => void navigateTo(entry.path) });
    } else if (entry.kind === "audio") {
      items.push({ label: "Import Audio", action: () => void actions.importAudioFile(entry.path) });
    } else if (entry.kind === "midi") {
      items.push({ label: "Import MIDI", action: () => void actions.importMidiFile(entry.path) });
    } else if (entry.kind === "project") {
      items.push({ label: "Open Project", action: () => void actions.openProjectPath(entry.path) });
    }
    items.push({ separator: true });
    items.push({
      label: "Use as Project Media Folder",
      disabled: !entry.isDir,
      action: () => void navigateTo(entry.path),
    });
    openContextMenu(event, items);
  });

  return row;
}

async function activate(entry: MediaEntry): Promise<void> {
  if (entry.isDir) {
    await navigateTo(entry.path);
    return;
  }
  if (entry.kind === "audio") void actions.importAudioFile(entry.path);
  else if (entry.kind === "midi") void actions.importMidiFile(entry.path);
  else if (entry.kind === "project") void actions.openProjectPath(entry.path);
}

function subtitle(entry: MediaEntry): string {
  if (entry.isDir) return "Folder";
  switch (entry.kind) {
    case "audio":
      return fileStem(entry.name).toLowerCase().endsWith("mixdown") ? "Audio · mixdown" : "Audio file";
    case "midi":
      return "Standard MIDI File";
    case "project":
      return "Studio Clone project";
    case "preset":
      return "Preset / JSON";
    default:
      return "File";
  }
}

export function navigateToProjectMedia(): void {
  if (state.projectPath) void navigateTo(projectMediaDir());
}
