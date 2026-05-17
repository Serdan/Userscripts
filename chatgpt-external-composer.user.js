// ==UserScript==
// @name         ChatGPT External Composer
// @namespace    local.chatgpt.external-composer
// @version      0.1.0
// @description  Type into a minimal external textarea and inject into ChatGPT's real composer only when sending.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "cgptExternalComposerDraft";
  const PANEL_ID = "cgpt-external-composer";

  const STATE = {
    collapsed: false,
    visible: true,
  };

  function cssText(obj) {
    return Object.entries(obj)
      .map(([key, value]) => `${key}:${value}`)
      .join(";");
  }

  function findRealComposer() {
    const selectors = [
      "#prompt-textarea",
      "textarea[data-testid*='composer']",
      "textarea[placeholder]",
      "textarea",
      "[contenteditable='true'][data-testid*='composer']",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
      "[role='textbox']",
    ];

    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const visible = nodes.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 20) return false;
        if (node.closest(`#${PANEL_ID}`)) return false;
        return true;
      });

      if (visible) return visible;
    }

    return null;
  }

  function setTextareaValue(textarea, value) {
    const proto = Object.getPrototypeOf(textarea);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

    if (descriptor?.set) {
      descriptor.set.call(textarea, value);
    } else {
      textarea.value = value;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditableValue(editable, value) {
    editable.focus();
    document.execCommand?.("selectAll", false, null);
    document.execCommand?.("insertText", false, value);

    if ((editable.textContent || "").trim() !== value.trim()) {
      editable.textContent = value;
    }

    editable.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value,
    }));
  }

  function injectIntoComposer(value) {
    const composer = findRealComposer();
    if (!composer) throw new Error("Could not find ChatGPT composer");

    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setTextareaValue(composer, value);
    } else {
      setEditableValue(composer, value);
    }

    return composer;
  }

  function findSendButton() {
    const selectors = [
      "button[data-testid='send-button']",
      "button[data-testid*='send']",
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "form button:not([disabled])",
    ];

    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const button = nodes.find((node) => {
        if (!(node instanceof HTMLButtonElement)) return false;
        if (node.disabled) return false;
        if (node.closest(`#${PANEL_ID}`)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10;
      });

      if (button) return button;
    }

    return null;
  }

  function clickSendButtonSoon() {
    setTimeout(() => {
      const button = findSendButton();
      if (!button) {
        console.warn("[cgpt-external-composer] Could not find send button after injection");
        return;
      }
      button.click();
    }, 75);
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.style.cssText = cssText({
      position: "fixed",
      right: "12px",
      bottom: "12px",
      width: "min(720px, calc(100vw - 24px))",
      "z-index": "2147483647",
      background: "Canvas",
      color: "CanvasText",
      border: "1px solid color-mix(in srgb, CanvasText 25%, transparent)",
      "border-radius": "10px",
      "box-shadow": "0 8px 24px rgba(0,0,0,0.25)",
      padding: "8px",
      contain: "layout style paint",
      "font-family": "system-ui, sans-serif",
    });

    const header = document.createElement("div");
    header.style.cssText = cssText({
      display: "flex",
      gap: "8px",
      "align-items": "center",
      "margin-bottom": "6px",
    });

    const title = document.createElement("strong");
    title.textContent = "External composer";
    title.style.cssText = cssText({
      "font-size": "12px",
      "margin-right": "auto",
      opacity: "0.8",
    });

    const send = document.createElement("button");
    send.textContent = "Inject + send";

    const inject = document.createElement("button");
    inject.textContent = "Inject only";

    const collapse = document.createElement("button");
    collapse.textContent = "Collapse";

    const hide = document.createElement("button");
    hide.textContent = "Hide";
    hide.title = "Alt+Shift+C toggles visibility";

    for (const button of [send, inject, collapse, hide]) {
      button.style.cssText = cssText({
        "font-size": "12px",
        padding: "4px 8px",
      });
    }

    header.append(title, inject, send, collapse, hide);

    const textarea = document.createElement("textarea");
    textarea.value = localStorage.getItem(STORAGE_KEY) || "";
    textarea.placeholder = "Type here instead of the ChatGPT prompt. Ctrl/Cmd+Enter injects and sends. Ctrl/Cmd+Shift+Enter injects only.";
    textarea.spellcheck = true;
    textarea.style.cssText = cssText({
      width: "100%",
      height: "11rem",
      resize: "vertical",
      "box-sizing": "border-box",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      "font-size": "14px",
      "line-height": "1.45",
      padding: "8px",
      color: "CanvasText",
      background: "Canvas",
      border: "1px solid color-mix(in srgb, CanvasText 25%, transparent)",
      "border-radius": "8px",
    });

    const status = document.createElement("div");
    status.style.cssText = cssText({
      "font-size": "11px",
      opacity: "0.75",
      "margin-top": "4px",
    });
    status.textContent = "Draft is saved locally in this browser.";

    function persist() {
      try {
        localStorage.setItem(STORAGE_KEY, textarea.value);
      } catch {}
    }

    function doInject({ sendAfter }) {
      const value = textarea.value;
      if (!value.trim()) return;

      try {
        injectIntoComposer(value);
        status.textContent = sendAfter ? "Injected; sending..." : "Injected into ChatGPT composer.";
        if (sendAfter) {
          clickSendButtonSoon();
          textarea.value = "";
          persist();
        }
      } catch (error) {
        status.textContent = String(error?.message || error);
        console.warn("[cgpt-external-composer]", error);
      }
    }

    textarea.addEventListener("input", persist);

    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        doInject({ sendAfter: !event.shiftKey });
      }
    });

    inject.addEventListener("click", () => doInject({ sendAfter: false }));
    send.addEventListener("click", () => doInject({ sendAfter: true }));

    collapse.addEventListener("click", () => {
      STATE.collapsed = !STATE.collapsed;
      textarea.style.display = STATE.collapsed ? "none" : "block";
      status.style.display = STATE.collapsed ? "none" : "block";
      collapse.textContent = STATE.collapsed ? "Expand" : "Collapse";
    });

    hide.addEventListener("click", () => {
      STATE.visible = false;
      panel.style.display = "none";
    });

    panel.append(header, textarea, status);
    document.documentElement.appendChild(panel);

    window.cgptExternalComposer = {
      panel,
      textarea,
      injectOnly() {
        doInject({ sendAfter: false });
      },
      send() {
        doInject({ sendAfter: true });
      },
      show() {
        STATE.visible = true;
        panel.style.display = "block";
        textarea.focus();
      },
      hide() {
        STATE.visible = false;
        panel.style.display = "none";
      },
      toggle() {
        if (STATE.visible) this.hide();
        else this.show();
      },
    };
  }

  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      window.cgptExternalComposer?.toggle();
    }
  }, true);

  createPanel();

  console.warn("[cgpt-external-composer] loaded. Alt+Shift+C toggles it. Ctrl/Cmd+Enter sends from the external composer.");
})();
