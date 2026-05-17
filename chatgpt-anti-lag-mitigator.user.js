// ==UserScript==
// @name         ChatGPT Anti-Lag Mitigator
// @namespace    local.chatgpt.antilag
// @version      0.1.0
// @description  Reduces rendering cost in long ChatGPT/custom GPT conversations by containing and freezing older UI blocks.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    keepLastBlocks: 8,
    scanIntervalMs: 8000,
    destructiveFreeze: false,
    destructiveKeepLast: 6,
    debug: false,
  };

  const STYLE_ID = "cgpt-antilag-style";
  let lastRun = 0;

  const log = (...args) => {
    if (CONFIG.debug) console.log("[cgpt-antilag]", ...args);
  };

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001s !important;
        scroll-behavior: auto !important;
      }

      main *, [role="main"] * {
        content-visibility: auto;
        contain-intrinsic-size: auto 160px;
      }

      .cgpt-antilag-old {
        content-visibility: auto !important;
        contain: layout style paint !important;
        contain-intrinsic-size: auto 120px !important;
      }

      .cgpt-antilag-old.cgpt-antilag-collapse {
        max-height: 12rem !important;
        overflow: hidden !important;
        position: relative !important;
      }

      .cgpt-antilag-old.cgpt-antilag-collapse::after {
        content: "Older content collapsed by anti-lag userscript";
        display: block;
        position: sticky;
        bottom: 0;
        padding: 0.35rem 0.5rem;
        font: 12px system-ui, sans-serif;
        opacity: 0.75;
        background: Canvas;
        color: CanvasText;
        border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      }

      .cgpt-antilag-old button,
      .cgpt-antilag-old svg,
      .cgpt-antilag-old [role="button"],
      .cgpt-antilag-old [data-testid*="copy"],
      .cgpt-antilag-old [data-testid*="feedback"],
      .cgpt-antilag-old [aria-label*="Copy"],
      .cgpt-antilag-old [aria-label*="copy"],
      .cgpt-antilag-old [aria-label*="Good"],
      .cgpt-antilag-old [aria-label*="Bad"] {
        display: none !important;
      }

      .cgpt-antilag-old pre,
      .cgpt-antilag-old code {
        max-height: 8rem !important;
        overflow: hidden !important;
        white-space: pre-wrap !important;
      }

      .cgpt-antilag-old table {
        display: block !important;
        max-height: 10rem !important;
        overflow: hidden !important;
      }

      .cgpt-antilag-frozen {
        contain: layout style paint !important;
        content-visibility: auto !important;
        contain-intrinsic-size: auto 100px !important;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function visibleEnough(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 100 && rect.height > 30;
  }

  function safeTextLength(el) {
    const text = el.textContent || "";
    return text.length;
  }

  function scoreCandidate(el) {
    let score = 0;
    const textLen = safeTextLength(el);
    const buttons = el.querySelectorAll?.("button")?.length ?? 0;
    const code = el.querySelectorAll?.("pre, code")?.length ?? 0;
    const tables = el.querySelectorAll?.("table")?.length ?? 0;
    const testid = el.getAttribute?.("data-testid") ?? "";
    const role = el.getAttribute?.("role") ?? "";

    if (textLen > 200) score += 3;
    if (textLen > 1000) score += 3;
    if (buttons > 3) score += 1;
    if (code > 0) score += 2;
    if (tables > 0) score += 2;
    if (/conversation|message|turn|response|thread/i.test(testid)) score += 4;
    if (role === "article") score += 5;

    return score;
  }

  function findLikelyBlocks() {
    const selectors = [
      "article",
      "[data-message-author-role]",
      "[data-testid*='conversation']",
      "[data-testid*='message']",
      "[data-testid*='turn']",
      "[data-testid*='thread']",
      "main [class*='group']",
      "main div",
    ];

    const seen = new Set();
    const candidates = [];

    for (const selector of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }

      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        if (el === document.body || el === document.documentElement) continue;
        if (el.matches("main, [role='main']") || el.querySelector("main")) continue;
        if (!visibleEnough(el)) continue;

        const score = scoreCandidate(el);
        if (score >= 5) {
          candidates.push({ el, score, top: el.getBoundingClientRect().top });
        }
      }
    }

    const sorted = candidates
      .sort((a, b) => a.top - b.top || b.score - a.score)
      .map((x) => x.el);

    const result = [];
    for (const el of sorted) {
      if (!result.some((existing) => existing.contains(el))) result.push(el);
    }

    return result;
  }

  function collapseOldBlocks(blocks) {
    blocks.forEach((el) => {
      el.classList.remove("cgpt-antilag-old", "cgpt-antilag-collapse");
    });

    const oldBlocks = blocks.slice(0, Math.max(0, blocks.length - CONFIG.keepLastBlocks));

    for (const el of oldBlocks) {
      if (el.dataset.cgptFrozen === "1") continue;
      el.classList.add("cgpt-antilag-old");

      const textLen = safeTextLength(el);
      const hasCode = Boolean(el.querySelector("pre, code"));
      const hasTable = Boolean(el.querySelector("table"));

      if (textLen > 2000 || hasCode || hasTable) {
        el.classList.add("cgpt-antilag-collapse");
      }
    }

    return oldBlocks.length;
  }

  function destructiveFreezeOldBlocks(blocks) {
    const oldBlocks = blocks.slice(0, Math.max(0, blocks.length - CONFIG.destructiveKeepLast));

    for (const el of oldBlocks) {
      if (el.dataset.cgptFrozen === "1") continue;
      if (el.contains(document.activeElement)) continue;

      const summary = (el.textContent || "").replace(/\s+/g, " ").slice(0, 240);
      const originalHeight = Math.max(80, Math.round(el.getBoundingClientRect().height));

      el.dataset.cgptFrozen = "1";
      el.dataset.cgptOriginalHeight = String(originalHeight);
      el.classList.add("cgpt-antilag-frozen");
      el.replaceChildren();

      const box = document.createElement("details");
      box.style.cssText = [
        "min-height:48px",
        "max-height:160px",
        "overflow:hidden",
        "contain:layout style paint",
        "content-visibility:auto",
        "border:1px solid color-mix(in srgb, CanvasText 18%, transparent)",
        "border-radius:8px",
        "padding:8px",
        "margin:4px 0",
        "font:13px system-ui,sans-serif",
        "opacity:0.75",
      ].join(";");

      const summaryEl = document.createElement("summary");
      summaryEl.textContent = "Frozen older ChatGPT block";
      box.appendChild(summaryEl);

      const p = document.createElement("p");
      p.textContent = summary || "(no text captured)";
      box.appendChild(p);

      el.appendChild(box);
    }

    return oldBlocks.length;
  }

  function applyMitigation() {
    const now = performance.now();
    if (now - lastRun < 1000) return;
    lastRun = now;

    injectCSS();
    const blocks = findLikelyBlocks();
    const collapsed = collapseOldBlocks(blocks);
    const frozen = CONFIG.destructiveFreeze ? destructiveFreezeOldBlocks(blocks) : 0;

    window.cgptAntiLag = {
      config: CONFIG,
      blocks: blocks.length,
      collapsed,
      frozen,
      rescan: applyMitigation,
      setDestructiveFreeze(value) {
        CONFIG.destructiveFreeze = Boolean(value);
        applyMitigation();
      },
      disable() {
        document.getElementById(STYLE_ID)?.remove();
        document
          .querySelectorAll(".cgpt-antilag-old, .cgpt-antilag-collapse, .cgpt-antilag-frozen")
          .forEach((el) => {
            el.classList.remove("cgpt-antilag-old", "cgpt-antilag-collapse", "cgpt-antilag-frozen");
          });
      },
    };

    log({ blocks: blocks.length, collapsed, frozen });
  }

  setTimeout(applyMitigation, 3000);
  setInterval(applyMitigation, CONFIG.scanIntervalMs);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(applyMitigation, 1500);
    }
  }, 2000);

  console.warn("[cgpt-antilag] loaded. Run cgptAntiLag.setDestructiveFreeze(true) for stronger mitigation.");
})();
