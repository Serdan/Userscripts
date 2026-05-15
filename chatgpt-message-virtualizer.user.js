// ==UserScript==
// @name         ChatGPT Message Virtualizer
// @namespace    local.chatgpt.virtualizer
// @version      0.3.0
// @description  Detach far-off ChatGPT conversation turns and replace them with height placeholders.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const DEFAULT_CONFIG = {
    turnSelector: '[data-testid^="conversation-turn-"]',
    keepLast: 10,
    overscanPx: 5000,
    fallbackHeightPx: 160,
    rescanDelayMs: 250,
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
    debug: false,
  };

  const CONFIG = {
    ...DEFAULT_CONFIG,
    ...(window.cgptVirtualizerConfig || {}),
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

  function isVirtualizerElement(node) {
    if (!(node instanceof Element)) return false;

    return (
      node.classList?.contains("cgpt-vmsg-placeholder") ||
      Boolean(node.querySelector?.(".cgpt-vmsg-placeholder"))
    );
  }

  const visibilityObserver = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        const entry =
          entriesByNode.get(record.target) ||
          entriesByPlaceholder.get(record.target);

        if (!entry) continue;
        entry.nearViewport = record.isIntersecting;
      }

      scheduleReconcile();
    },
    {
      root: null,
      rootMargin: `${CONFIG.overscanPx}px 0px`,
      threshold: 0,
    }
  );

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
      nearViewport: null,
    };

    entriesById.set(id, entry);
    entriesByNode.set(node, entry);
    entriesByPlaceholder.set(placeholder, entry);
    visibilityObserver.observe(node);

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

  function cleanupDisconnectedEntries() {
    for (const [id, entry] of entriesById) {
      const nodeConnected = entry.node?.isConnected;
      const placeholderConnected = entry.placeholder?.isConnected;

      if (!nodeConnected && !placeholderConnected) {
        visibilityObserver.unobserve(entry.node);
        visibilityObserver.unobserve(entry.placeholder);
        entriesById.delete(id);
        log("forgot disconnected entry", id);
      }
    }
  }

  function orderedEntriesInDocument() {
    const selector = `${CONFIG.turnSelector}, .cgpt-vmsg-placeholder`;
    const ordered = [];
    const seen = new Set();

    for (const el of document.querySelectorAll(selector)) {
      const entry = entriesByNode.get(el) || entriesByPlaceholder.get(el);
      if (!entry || seen.has(entry.id)) continue;

      seen.add(entry.id);
      ordered.push(entry);
    }

    ordered.forEach((entry, index) => {
      entry.lastSeenIndex = index;
    });

    return ordered;
  }

  function shouldMount(entry, orderedLength) {
    const newestCutoff = Math.max(0, orderedLength - CONFIG.keepLast);

    if (entry.lastSeenIndex >= newestCutoff) return true;
    if (entry.mounted && nodeLooksActiveOrGenerating(entry.node)) return true;

    const anchor = entry.mounted ? entry.node : entry.placeholder;
    if (!anchor || !anchor.isConnected) return true;

    if (typeof entry.nearViewport === "boolean") return entry.nearViewport;

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
    if (nodeLooksActiveOrGenerating(node)) return false;

    if (hasActiveGeneration()) {
      const ordered = orderedEntriesInDocument();
      const newestCutoff = Math.max(0, ordered.length - CONFIG.keepLast);

      if (entry.lastSeenIndex >= newestCutoff) return false;
    }

    return true;
  }

  function preserveScrollWhileReplacing(anchor, getReplacement, replace) {
    const beforeRect = anchor.getBoundingClientRect();
    const wasAboveViewport = beforeRect.bottom < 0;

    replace();

    if (!wasAboveViewport) return;

    const replacement = getReplacement();
    const afterHeight =
      replacement?.getBoundingClientRect?.().height ?? beforeRect.height;
    const delta = afterHeight - beforeRect.height;

    if (delta !== 0) window.scrollBy(0, delta);
  }

  function mount(entry) {
    if (entry.mounted) return;

    const ph = entry.placeholder;
    if (!ph.isConnected || !ph.parentNode) return;

    preserveScrollWhileReplacing(ph, () => entry.node, () => {
      ph.replaceWith(entry.node);
      visibilityObserver.unobserve(ph);
      visibilityObserver.observe(entry.node);
      entry.mounted = true;
      entry.nearViewport = true;
    });

    log("mounted", entry.id);
  }

  function unmount(entry) {
    if (!entry.mounted) return;
    if (!isSafeToDetach(entry)) return;

    const node = entry.node;
    if (!node.isConnected || !node.parentNode) return;

    entry.height = measureHeight(node);
    entry.placeholder.style.height = `${entry.height}px`;

    preserveScrollWhileReplacing(node, () => entry.placeholder, () => {
      node.parentNode.insertBefore(entry.placeholder, node);
      node.remove();
      visibilityObserver.unobserve(node);
      visibilityObserver.observe(entry.placeholder);
      entry.mounted = false;
      entry.nearViewport = false;
    });

    log("unmounted", entry.id, entry.height);
  }

  function reconcile() {
    scheduled = false;

    if (!enabled) return;

    cleanupDisconnectedEntries();
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
    for (const entry of entriesById.values()) mount(entry);
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

  function mutationMayContainTurns(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];

    return nodes.some((node) => {
      if (!(node instanceof Element)) return false;
      if (isVirtualizerElement(node)) return false;
      if (entriesByNode.has(node) || entriesByPlaceholder.has(node)) return false;

      return (
        node.matches?.(CONFIG.turnSelector) ||
        Boolean(node.querySelector?.(CONFIG.turnSelector))
      );
    });
  }

  window.cgptVirtualizer = {
    get enabled() {
      return enabled;
    },
    get config() {
      return { ...CONFIG };
    },
    toggle: toggleEnabled,
    hydrateAll,
    stats() {
      const entries = [...entriesById.values()];

      return {
        total: entries.length,
        mounted: entries.filter((entry) => entry.mounted).length,
        virtualized: entries.filter((entry) => !entry.mounted).length,
        activeGeneration: hasActiveGeneration(),
      };
    },
  };

  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyV") {
      toggleEnabled();
    }
  });

  window.addEventListener("scroll", scheduleReconcile, { passive: true });
  window.addEventListener("resize", scheduleReconcile, { passive: true });

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationMayContainTurns)) scheduleRescan();
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
