// ==UserScript==
// @name         ChatGPT Render Gate
// @namespace    local.chatgpt.render-gate
// @version      0.2.0
// @description  Reduces ChatGPT streaming render pressure by temporarily blanking older transcript/tool UI while preserving layout.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    pollMs: 500,
    releaseDelayMs: 1200,
    keepNewest: 2,
    mode: "blank", // "blank" or "dim"
    debug: false,
  };

  const STYLE_ID = "cgpt-render-gate-style";
  let gated = false;
  let releaseTimer = null;
  let lastCandidateCount = 0;
  let lastGatedCount = 0;

  const log = (...args) => {
    if (CONFIG.debug) console.log("[cgpt-render-gate]", ...args);
  };

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .cgpt-render-gated-blank {
        visibility: hidden !important;
        pointer-events: none !important;
        user-select: none !important;
        contain: paint style !important;
      }

      .cgpt-render-gated-dim {
        opacity: 0.08 !important;
        pointer-events: none !important;
        user-select: none !important;
        contain: paint style !important;
      }

      #cgpt-render-gate-indicator {
        position: fixed;
        z-index: 2147483647;
        left: 12px;
        bottom: 12px;
        padding: 6px 8px;
        border-radius: 8px;
        background: Canvas;
        color: CanvasText;
        border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
        box-shadow: 0 6px 20px rgba(0,0,0,0.2);
        font: 12px system-ui, sans-serif;
        opacity: 0.8;
        contain: layout style paint;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function selectorExists(selector, root = document) {
    try {
      return Boolean(root.querySelector(selector));
    } catch {
      return false;
    }
  }

  function isGenerating() {
    const selectors = [
      '[data-testid*="stop"]',
      '[aria-label*="Stop"]',
      '[aria-label*="stop"]',
      '[aria-busy="true"]',
      '[data-testid*="streaming"]',
      '[data-testid*="loading"]',
      '[aria-label*="Generating"]',
      '[aria-label*="generating"]',
    ];

    return selectors.some((selector) => selectorExists(selector));
  }

  function isEditableOrComposer(el) {
    if (!(el instanceof HTMLElement)) return false;

    return Boolean(
      el.closest(
        [
          "textarea",
          "input",
          "[contenteditable='true']",
          "[role='textbox']",
          "form",
          "[data-testid*='composer']",
          "[data-testid*='prompt']",
          "[data-testid*='input']",
          `#cgpt-render-gate-indicator`,
          `#cgpt-external-composer`,
        ].join(",")
      )
    );
  }

  function visibleEnough(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 100 && rect.height > 30;
  }

  function findMainRoot() {
    return document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
  }

  function scoreCandidate(el) {
    let score = 0;
    const testid = el.getAttribute?.("data-testid") || "";
    const role = el.getAttribute?.("role") || "";
    const textLen = (el.textContent || "").length;
    const codeCount = el.querySelectorAll?.("pre, code")?.length || 0;
    const buttonCount = el.querySelectorAll?.("button")?.length || 0;

    if (/conversation|message|turn|response|thread|tool|result/i.test(testid)) score += 5;
    if (role === "article") score += 5;
    if (textLen > 150) score += 2;
    if (textLen > 1000) score += 2;
    if (codeCount > 0) score += 2;
    if (buttonCount > 4) score += 1;

    return score;
  }

  function findGateCandidates() {
    const root = findMainRoot();
    const selectors = [
      '[data-testid^="conversation-turn-"]',
      "article",
      "[data-message-author-role]",
      '[data-testid*="conversation"]',
      '[data-testid*="message"]',
      '[data-testid*="turn"]',
      '[data-testid*="response"]',
      '[data-testid*="thread"]',
      '[data-testid*="tool"]',
      "main [class*='group']",
      "main div",
    ];

    const seen = new Set();
    const scored = [];

    for (const selector of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }

      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (seen.has(el)) continue;
        seen.add(el);

        if (el === document.body || el === document.documentElement || el === root) continue;
        if (isEditableOrComposer(el)) continue;
        if (!visibleEnough(el)) continue;
        if (el.contains(document.activeElement) && isEditableOrComposer(document.activeElement)) continue;

        const score = scoreCandidate(el);
        if (score >= 5) {
          scored.push({ el, score, top: el.getBoundingClientRect().top });
        }
      }
    }

    const sorted = scored
      .sort((a, b) => a.top - b.top || b.score - a.score)
      .map((entry) => entry.el);

    const result = [];
    for (const el of sorted) {
      const containedByExisting = result.some((existing) => existing.contains(el));
      if (!containedByExisting) result.push(el);
    }

    return result;
  }

  function ensureIndicator() {
    let indicator = document.getElementById("cgpt-render-gate-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "cgpt-render-gate-indicator";
      document.documentElement.appendChild(indicator);
    }
    indicator.textContent = `Render gate: ${lastGatedCount}/${lastCandidateCount} older blocks blanked; newest ${CONFIG.keepNewest} kept visible. Alt+Shift+G toggles.`;
  }

  function removeIndicator() {
    document.getElementById("cgpt-render-gate-indicator")?.remove();
  }

  function clearGateClasses() {
    document
      .querySelectorAll(".cgpt-render-gated-blank, .cgpt-render-gated-dim")
      .forEach((el) => {
        el.classList.remove("cgpt-render-gated-blank", "cgpt-render-gated-dim");
      });
  }

  function applyGate() {
    injectCSS();
    clearTimeout(releaseTimer);

    const candidates = findGateCandidates();
    lastCandidateCount = candidates.length;

    const toGate = candidates.slice(0, Math.max(0, candidates.length - CONFIG.keepNewest));
    const toKeep = candidates.slice(Math.max(0, candidates.length - CONFIG.keepNewest));
    lastGatedCount = toGate.length;

    const cls = CONFIG.mode === "dim" ? "cgpt-render-gated-dim" : "cgpt-render-gated-blank";
    const otherCls = CONFIG.mode === "dim" ? "cgpt-render-gated-blank" : "cgpt-render-gated-dim";

    for (const el of toKeep) {
      el.classList.remove("cgpt-render-gated-blank", "cgpt-render-gated-dim");
    }

    for (const el of toGate) {
      el.classList.remove(otherCls);
      el.classList.add(cls);
    }

    gated = true;
    ensureIndicator();
    log("gated", { candidates: candidates.length, gated: toGate.length, kept: toKeep.length });
  }

  function releaseGate() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      clearGateClasses();
      gated = false;
      removeIndicator();
      log("released");
    }, CONFIG.releaseDelayMs);
  }

  function tick() {
    if (isGenerating()) {
      applyGate();
    } else if (gated) {
      releaseGate();
    }
  }

  function toggleMode() {
    CONFIG.mode = CONFIG.mode === "blank" ? "dim" : "blank";
    if (gated) applyGate();
    console.warn(`[cgpt-render-gate] mode=${CONFIG.mode}`);
  }

  window.cgptRenderGate = {
    config: CONFIG,
    apply: applyGate,
    release: releaseGate,
    toggleMode,
    clear: clearGateClasses,
    candidates: findGateCandidates,
    stats() {
      return {
        generating: isGenerating(),
        gated,
        candidates: findGateCandidates().length,
        gatedCount: lastGatedCount,
        keepNewest: CONFIG.keepNewest,
        mode: CONFIG.mode,
      };
    },
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.altKey && event.shiftKey && event.code === "KeyG") {
        event.preventDefault();
        toggleMode();
      }
    },
    true
  );

  setInterval(tick, CONFIG.pollMs);
  setTimeout(tick, 1500);

  console.warn("[cgpt-render-gate] loaded. During generation it blanks older transcript/tool blocks while preserving layout. Alt+Shift+G toggles blank/dim mode.");
})();
