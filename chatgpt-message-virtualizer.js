// ==UserScript==
// @name         ChatGPT Message Virtualizer
// @namespace    local.chatgpt.virtualizer
// @version      0.2.0
// @description  Detach far-off ChatGPT conversation turns and replace them with height placeholders.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    // ChatGPT currently tends to use this shape for conversation turns.
    // Adjust this selector if the frontend changes.
    turnSelector: '[data-testid^="conversation-turn-"]',

    // Keep this many newest turns mounted no matter where they are.
    keepLast: 10,

    // Mount anything within this many pixels above/below the viewport.
    overscanPx: 5000,

    // Minimum placeholder height if measurement fails.
    fallbackHeightPx: 160,

    // Throttle-ish delay for rescans.
    rescanDelayMs: 250,

    // Conservative selectors for streaming / generating / stop UI.
    // These are intentionally broad and may need adjustment as ChatGPT changes.
    activeGenerationSelectors: [
      '[aria-busy="true"]',
      '[data-testid*="stop"]',
      '[data-testid*="streaming"]',
      '[data-testid*="loading"]',
      '[aria-label*="Stop"]',
      '[aria-label*="stop"]',
      '[aria-label*="Generating"]',
      '[aria-label*="generating"]',
      '[aria-label*="Loading"]',
      '[aria-label*="loading"]',
    ],

    // Debug logs.
    debug: false,
  };

  let enabled = true;
  let nextId = 1;
  let scheduled = false;
  let rescanTimer = null;

  const entriesById = new Map();
  const entriesByNode = new WeakMap();
  const entriesByPlaceholder = new WeakMap();

  const log = (...args) => {
    if (CONFIG.debug) console.log("[cgpt-virtualizer]", ...args);
  };

  const style = document.createElement("style");
  style.textContent = `
    .cgpt-vmsg-placeholder {
      box-sizing: border-box;
      width: 100%;
      contain: strict;
      content-visibility: auto;
      pointer-events: none;
      opacity: 0;
    }

    ${CONFIG.turnSelector} {
      content-visibility: auto;
      contain-intrinsic-size: auto 300px;
    }
  `;
  document.documentElement.appendChild(style);

  function selectorExists(selector, root = document) {
    try {
      return Boolean(root.querySelector?.(selector));
    } catch {
      return false;
    }
  }

  function selectorMatches(node, selector) {
    try {
      return Boolean(node.matches?.(selector));
    } catch {
      return false;
    }
  }

  function hasActiveGeneration() {
    return CONFIG.activeGenerationSelectors.some((selector) =>
      selectorExists(selector, document)
    );
  }

  function nodeLooksActiveOrGenerating(node) {
    if (!node) return false;

    return CONFIG.activeGenerationSelectors.some((selector) => {
      return selectorMatches(node, selector) || selectorExists(selector, node);
    });
  }

  function isNodeInSelection(node) {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return false;

    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);

      if (
        node.contains(range.startContainer) ||
        node.contains(range.endContainer)
      ) {
        return true;
      }
    }

    return false;
  }

  function measureHeight(node) {
    const rect = node.getBoundingClientRect();
    const h = rect.height || node.offsetHeight || CONFIG.fallbackHeightPx;
    return Math.max(CONFIG.fallbackHeightPx, Math.ceil(h));
  }

  function createEntry(node) {
    const id = String(nextId++);
    const placeholder = document.createElement("div");

    placeholder.className = "cgpt-vmsg-placeholder";
    placeholder.dataset.cgptVirtualizedMessage = id;
    placeholder.style.height = `${CONFIG.fallbackHeightPx}px`;

    const entry = {
      id,
      node,
      placeholder,
      mounted: true,
      height: CONFIG.fallbackHeightPx,
      lastSeenIndex: 0,
    };

    entriesById.set(id, entry);
    entriesByNode.set(node, entry);
    entriesByPlaceholder.set(placeholder, entry);

    return entry;
  }

  function collectMountedTurns() {
    const nodes = Array.from(document.querySelectorAll(CONFIG.turnSelector));

    for (const node of nodes) {
      if (entriesByNode.has(node)) continue;
      if (!node.isConnected) continue;

      const entry = createEntry(node);
      entry.height = measureHeight(node);

      log("tracked", entry.id, entry.height);
    }
  }

  function orderedEntriesInDocument() {
    const selector = `${CONFIG.turnSelector}, .cgpt-vmsg-placeholder`;
    const ordered = [];

    for (const el of document.querySelectorAll(selector)) {
      const entry = entriesByNode.get(el) || entriesByPlaceholder.get(el);
      if (entry) ordered.push(entry);
    }

    ordered.forEach((entry, index) => {
      entry.lastSeenIndex = index;
    });

    return ordered;
  }

  function shouldMount(entry, orderedLength) {
    const newestCutoff = Math.max(0, orderedLength - CONFIG.keepLast);

    // Always keep the newest N turns mounted, even if scrolled far away.
    // This protects the active generation placeholder / streaming response tail.
    if (entry.lastSeenIndex >= newestCutoff) return true;

    // Never virtualize a mounted node that appears to contain active generation UI.
    if (entry.mounted && nodeLooksActiveOrGenerating(entry.node)) return true;

    const anchor = entry.mounted ? entry.node : entry.placeholder;
    if (!anchor || !anchor.isConnected) return true;

    const rect = anchor.getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;

    return (
      rect.bottom >= -CONFIG.overscanPx &&
      rect.top <= viewportHeight + CONFIG.overscanPx
    );
  }

  function isSafeToDetach(entry) {
    const node = entry.node;
    if (!node || !node.isConnected) return false;

    if (node.contains(document.activeElement)) return false;
    if (isNodeInSelection(node)) return false;

    // Never detach a turn containing active / streaming / generating UI.
    if (nodeLooksActiveOrGenerating(node)) return false;

    // While any generation is active anywhere, be extra conservative around
    // the newest retained region. This matters when scrolling to the top
    // during response generation.
    if (hasActiveGeneration()) {
      const ordered = orderedEntriesInDocument();
      const newestCutoff = Math.max(0, ordered.length - CONFIG.keepLast);

      if (entry.lastSeenIndex >= newestCutoff) {
        return false;
      }
    }

    return true;
  }

  function mount(entry) {
    if (entry.mounted) return;

    const ph = entry.placeholder;
    if (!ph.isConnected || !ph.parentNode) return;

    ph.replaceWith(entry.node);
    entry.mounted = true;

    log("mounted", entry.id);
  }

  function unmount(entry) {
    if (!entry.mounted) return;
    if (!isSafeToDetach(entry)) return;

    const node = entry.node;
    if (!node.isConnected || !node.parentNode) return;

    entry.height = measureHeight(node);
    entry.placeholder.style.height = `${entry.height}px`;

    node.parentNode.insertBefore(entry.placeholder, node);
    node.remove();

    entry.mounted = false;

    log("unmounted", entry.id, entry.height);
  }

  function reconcile() {
    scheduled = false;

    if (!enabled) return;

    collectMountedTurns();

    const ordered = orderedEntriesInDocument();
    const orderedLength = ordered.length;

    for (const entry of ordered) {
      if (shouldMount(entry, orderedLength)) {
        mount(entry);
      } else {
        unmount(entry);
      }
    }
  }

  function scheduleReconcile() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(reconcile);
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(scheduleReconcile, CONFIG.rescanDelayMs);
  }

  function hydrateAll() {
    for (const entry of entriesById.values()) {
      mount(entry);
    }
  }

  function toggleEnabled() {
    enabled = !enabled;

    if (!enabled) {
      hydrateAll();
      console.warn("[cgpt-virtualizer] disabled; all messages reattached");
    } else {
      console.warn("[cgpt-virtualizer] enabled");
      scheduleReconcile();
    }
  }

  // Kill switch: Alt+Shift+V
  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyV") {
      toggleEnabled();
    }
  });

  window.addEventListener("scroll", scheduleReconcile, { passive: true });
  window.addEventListener("resize", scheduleReconcile, { passive: true });

  const observer = new MutationObserver(() => {
    scheduleRescan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  scheduleReconcile();

  console.warn(
    "[cgpt-virtualizer] loaded. Alt+Shift+V toggles it. Experimental; may break if ChatGPT changes its DOM."
  );
})();