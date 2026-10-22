import "./styles/base.css";
import "./styles/shell.css";
import "./styles/arrangement.css";
import "./styles/piano.css";
import "./styles/mixer.css";
import "./styles/inspector.css";
import "./styles/modals.css";

import * as actions from "./actions";
import { state } from "./store";
import { h } from "./utils/dom";
import { mountShell, updateWindowChrome } from "./ui/shell";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Application root element is missing.");

function bootScreen(status: string, detail?: string): HTMLElement {
  return h(
    "div",
    { class: "boot-screen" },
    h("div", { class: "boot-mark", text: "SC" }),
    h("h1", { text: "Studio Clone" }),
    h("p", { text: "Digital audio workstation" }),
    h("div", { class: "boot-status", text: status }),
    detail ? h("div", { class: "boot-detail", text: detail }) : null,
  );
}

function failureScreen(message: string): HTMLElement {
  const retry = h("button", {
    class: "text-btn primary boot-retry",
    type: "button",
    text: "Retry",
    onClick: () => void boot(),
  });
  return h(
    "div",
    { class: "boot-screen boot-failure" },
    h("div", { class: "boot-mark", text: "SC" }),
    h("h1", { text: "Studio Clone could not start" }),
    h("p", { text: "The audio backend or project storage could not be initialized." }),
    h("pre", { class: "boot-error", text: message }),
    retry,
    h("div", { class: "boot-status", text: "Check the console for the full error." }),
  );
}

async function boot(): Promise<void> {
  state.bootError = null;
  root!.replaceChildren(bootScreen("Initializing audio engine…", "Enumerating WASAPI devices and project storage"));
  try {
    await actions.initApplication();
    root!.replaceChildren();
    mountShell(root!);
    updateWindowChrome();
  } catch (error) {
    console.error("Studio Clone failed to initialize", error);
    const message = error instanceof Error ? error.message : String(error);
    root!.replaceChildren(failureScreen(message));
  }
}

void boot();
