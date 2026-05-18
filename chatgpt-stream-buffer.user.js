// ==UserScript==
// @name         ChatGPT Stream Buffer
// @namespace    local.chatgpt.stream-buffer
// @version      0.3.0
// @description  Buffers ChatGPT event streams and performs post-response cleanup to reduce long-chat renderer stalls.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (page.__cgptStreamBufferInstalled) return;
  page.__cgptStreamBufferInstalled = true;

  const STYLE_ID = "cgpt-performance-mode-style";
  const BADGE_ID = "cgpt-stream-buffer-badge";
  const DRAFT_KEY = "cgptPerformanceModeDraft";

  const CONFIG = {
    enabled: true,
    bufferAllEventStreams: true,
    showBadge: false,
    performanceMode: true,
    cleanupAfterBufferedResponses: true,
    keepNewestBlocks: 8,
    collapseTextOverChars: 2200,
    longTaskMs: 500,
    autoReloadAfterResponse: false,
    autoReloadLongTaskThreshold: 30,
    debug: false,
    maxBufferBytes: 64 * 1024 * 1024,
    urlPatterns: [
      /\/backend-api\//,
      /\/conversation(?:\?|$|\/)/,
      /\/responses(?:\?|$|\/)/,
      /\/codex\//,
    ],
    contentTypes: [
      "text/event-stream",
      "application/x-ndjson",
      "application/jsonl",
      "text/plain",
    ],
  };

  const stats = {
    fetchCalls: 0,
    matchedUrl: 0,
    streamResponses: 0,
    buffered: 0,
    passedThrough: 0,
    failed: 0,
    cleanedBlocks: 0,
    frozenBlocks: 0,
    longTasks: 0,
    lastUrl: "",
    lastContentType: "",
    lastBufferedBytes: 0,
    lastError: "",
    lastCleanupAt: 0,
  };

  const originalFetch = page.fetch.bind(page);

  function log(...args) {
    if (CONFIG.debug) console.log("[cgpt-performance-mode]", ...args);
  }

  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === "string") return input.url;
    } catch {}
    return "";
  }

  function shouldConsiderUrl(url) {
    if (!url) return false;
    return CONFIG.urlPatterns.some((pattern) => pattern.test(url));
  }

  function contentTypeMatches(contentType) {
    if (!contentType) return false;
    return CONFIG.contentTypes.some((type) => contentType.includes(type));
  }

  function shouldBufferResponse(url, response) {
    if (!CONFIG.enabled) return false;
    if (!response || !response.body) return false;

    const contentType = response.headers.get("content-type") || "";
    const urlMatches = shouldConsiderUrl(url);
    const typeMatches = contentTypeMatches(contentType);

    if (urlMatches) stats.matchedUrl++;
    if (typeMatches) stats.streamResponses++;

    if (CONFIG.bufferAllEventStreams && typeMatches) return true;
    return urlMatches && (!contentType || typeMatches);
  }

  function injectCSS() {
    if (!page.document || page.document.getElementById(STYLE_ID)) return;

    const style = page.document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .cgpt-perf-frozen {
        content-visibility: auto !important;
        contain: layout style paint !important;
        contain-intrinsic-size: auto 140px !important;
      }

      .cgpt-perf-collapsed {
        max-height: 12rem !important;
        overflow: hidden !important;
        position: relative !important;
      }

      .cgpt-perf-collapsed::after {
        content: "Older content collapsed by ChatGPT Performance Mode";
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

      .cgpt-perf-frozen button,
      .cgpt-perf-frozen svg,
      .cgpt-perf-frozen [role="button"],
      .cgpt-perf-frozen [data-testid*="copy"],
      .cgpt-perf-frozen [data-testid*="feedback"],
      .cgpt-perf-frozen [aria-label*="Copy"],
      .cgpt-perf-frozen [aria-label*="copy"],
      .cgpt-perf-frozen [aria-label*="Good"],
      .cgpt-perf-frozen [aria-label*="Bad"] {
        display: none !important;
      }

      .cgpt-perf-frozen pre,
      .cgpt-perf-frozen code {
        max-height: 8rem !important;
        overflow: hidden !important;
        white-space: pre-wrap !important;
      }

      .cgpt-perf-frozen table {
        display: block !important;
        max-height: 10rem !important;
        overflow: hidden !important;
      }
    `;

    page.document.documentElement.appendChild(style);
  }

  function installBadge() {
    if (!CONFIG.showBadge) return;
    if (!page.document || page.document.getElementById(BADGE_ID)) return;

    const badge = page.document.createElement("div");
    badge.id = BADGE_ID;
    badge.style.cssText = [
      "position:fixed",
      "right:12px",
      "top:64px",
      "z-index:2147483647",
      "font:12px system-ui,sans-serif",
      "padding:6px 8px",
      "border-radius:8px",
      "background:Canvas",
      "color:CanvasText",
      "border:1px solid color-mix(in srgb, CanvasText 25%, transparent)",
      "box-shadow:0 6px 20px rgba(0,0,0,0.2)",
      "opacity:0.85",
      "pointer-events:none",
      "contain:layout style paint",
    ].join(";");

    page.document.documentElement.appendChild(badge);
  }

  function updateBadge(text) {
    try {
      if (!CONFIG.showBadge) {
        page.document?.getElementById(BADGE_ID)?.remove();
        return;
      }
      installBadge();
      const badge = page.document.getElementById(BADGE_ID);
      if (badge) {
        badge.textContent = text || (
          "PerfMode " +
          (CONFIG.enabled ? "on" : "off") +
          " | streams " + stats.streamResponses +
          " | buffered " + stats.buffered +
          " | frozen " + stats.frozenBlocks +
          " | long " + stats.longTasks
        );
      }
    } catch {}
  }

  function isEditableOrComposer(el) {
    if (!(el instanceof page.HTMLElement)) return false;
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
          "#cgpt-external-composer",
          "#" + BADGE_ID,
        ].join(",")
      )
    );
  }

  function visibleEnough(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 100 && rect.height > 30;
  }

  function scoreCandidate(el) {
    let score = 0;
    const testid = el.getAttribute?.("data-testid") || "";
    const role = el.getAttribute?.("role") || "";
    const textLen = (el.textContent || "").length;
    const codeCount = el.querySelectorAll?.("pre, code")?.length || 0;
    const tableCount = el.querySelectorAll?.("table")?.length || 0;
    const buttonCount = el.querySelectorAll?.("button")?.length || 0;

    if (/conversation|message|turn|response|thread|tool|result/i.test(testid)) score += 5;
    if (role === "article") score += 5;
    if (textLen > 150) score += 2;
    if (textLen > 1000) score += 2;
    if (codeCount > 0) score += 2;
    if (tableCount > 0) score += 2;
    if (buttonCount > 4) score += 1;

    return score;
  }

  function findMainRoot() {
    return page.document.querySelector("main") || page.document.querySelector('[role="main"]') || page.document.body;
  }

  function findMessageBlocks() {
    if (!page.document?.body) return [];

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
        if (!(el instanceof page.HTMLElement)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        if (el === page.document.body || el === page.document.documentElement || el === root) continue;
        if (isEditableOrComposer(el)) continue;
        if (el.contains(page.document.activeElement) && isEditableOrComposer(page.document.activeElement)) continue;
        if (!visibleEnough(el)) continue;

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
      if (!result.some((existing) => existing.contains(el))) result.push(el);
    }

    return result;
  }

  function preserveDraft() {
    try {
      const el = page.document.querySelector("#prompt-textarea, textarea, [contenteditable='true'][role='textbox'], [role='textbox']");
      if (!el) return;
      const value = "value" in el ? el.value : el.textContent;
      if (value) page.localStorage.setItem(DRAFT_KEY, value);
    } catch {}
  }

  function cleanupTranscript(reason = "manual") {
    if (!CONFIG.performanceMode || !CONFIG.cleanupAfterBufferedResponses) return;
    if (!page.document?.body) return;

    injectCSS();
    preserveDraft();

    const blocks = findMessageBlocks();
    const toFreeze = blocks.slice(0, Math.max(0, blocks.length - CONFIG.keepNewestBlocks));

    for (const el of blocks.slice(-CONFIG.keepNewestBlocks)) {
      el.classList.remove("cgpt-perf-frozen", "cgpt-perf-collapsed");
    }

    let changed = 0;
    for (const el of toFreeze) {
      if (isEditableOrComposer(el)) continue;
      el.classList.add("cgpt-perf-frozen");

      const textLen = (el.textContent || "").length;
      const heavy = textLen > CONFIG.collapseTextOverChars || Boolean(el.querySelector("pre, code, table"));
      if (heavy) el.classList.add("cgpt-perf-collapsed");
      changed++;
    }

    stats.cleanedBlocks += changed;
    stats.frozenBlocks = page.document.querySelectorAll(".cgpt-perf-frozen").length;
    stats.lastCleanupAt = Date.now();
    updateBadge("PerfMode: cleaned " + changed + " blocks (" + reason + ")");
    log("cleanup", { reason, blocks: blocks.length, changed });

    if (CONFIG.autoReloadAfterResponse && stats.longTasks >= CONFIG.autoReloadLongTaskThreshold) {
      setTimeout(() => page.location.reload(), 1200);
    }
  }

  function installLongTaskWatchdog() {
    try {
      const observer = new page.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= CONFIG.longTaskMs) {
            stats.longTasks++;
            updateBadge();
          }
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {}
  }

  async function bufferResponse(url, response) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    updateBadge("PerfMode: buffering...");

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        total += value.byteLength || value.length || 0;

        if (total > CONFIG.maxBufferBytes) {
          stats.passedThrough++;
          stats.lastBufferedBytes = total;
          log("buffer limit exceeded; falling back to original stream", { url, total });
          try { reader.releaseLock(); } catch {}
          updateBadge("PerfMode: buffer limit; pass-through");
          return response;
        }

        chunks.push(value);
      }
    } catch (error) {
      stats.failed++;
      stats.lastError = String(error && error.message ? error.message : error);
      updateBadge("PerfMode: failed");
      log("buffer failed", error);
      throw error;
    }

    stats.buffered++;
    stats.lastBufferedBytes = total;
    updateBadge("PerfMode: delivering " + Math.round(total / 1024) + " KiB");
    log("buffered response", { url, total, chunks: chunks.length });

    setTimeout(() => cleanupTranscript("buffered-response"), 1500);
    setTimeout(() => cleanupTranscript("post-buffered-response"), 5000);

    return new Response(new Blob(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  page.fetch = async function patchedFetch(input, init) {
    stats.fetchCalls++;
    const url = requestUrl(input);
    stats.lastUrl = url;

    const response = await originalFetch(input, init);
    stats.lastContentType = response.headers.get("content-type") || "";

    if (!shouldBufferResponse(url, response)) {
      stats.passedThrough++;
      updateBadge();
      return response;
    }

    return bufferResponse(url, response);
  };

  function toggleBadge() {
    CONFIG.showBadge = !CONFIG.showBadge;
    updateBadge();
    console.warn("[cgpt-performance-mode] showBadge=" + CONFIG.showBadge);
  }

  page.cgptStreamBuffer = {
    config: CONFIG,
    stats,
    enable() {
      CONFIG.enabled = true;
      updateBadge();
      console.warn("[cgpt-performance-mode] enabled");
    },
    disable() {
      CONFIG.enabled = false;
      updateBadge();
      console.warn("[cgpt-performance-mode] disabled");
    },
    toggle() {
      CONFIG.enabled = !CONFIG.enabled;
      updateBadge();
      console.warn("[cgpt-performance-mode] enabled=" + CONFIG.enabled);
    },
    toggleBadge,
    cleanup: cleanupTranscript,
    freezeNow() {
      cleanupTranscript("manual");
    },
    clearFrozen() {
      page.document
        .querySelectorAll(".cgpt-perf-frozen, .cgpt-perf-collapsed")
        .forEach((el) => el.classList.remove("cgpt-perf-frozen", "cgpt-perf-collapsed"));
      stats.frozenBlocks = 0;
      updateBadge();
    },
  };

  page.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyB") {
      event.preventDefault();
      page.cgptStreamBuffer.toggle();
    }
    if (event.altKey && event.shiftKey && event.code === "KeyV") {
      event.preventDefault();
      toggleBadge();
    }
    if (event.altKey && event.shiftKey && event.code === "KeyF") {
      event.preventDefault();
      cleanupTranscript("hotkey");
    }
  }, true);

  installLongTaskWatchdog();

  const onReady = () => {
    injectCSS();
    updateBadge();
    setTimeout(() => cleanupTranscript("initial"), 5000);
  };

  if (page.document?.readyState === "loading") {
    page.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  console.warn("[cgpt-performance-mode] loaded. Alt+Shift+B toggles buffering, Alt+Shift+V toggles status, Alt+Shift+F freezes old content now.");
})();
