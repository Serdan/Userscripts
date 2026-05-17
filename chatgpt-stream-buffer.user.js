// ==UserScript==
// @name         ChatGPT Stream Buffer
// @namespace    local.chatgpt.stream-buffer
// @version      0.2.1
// @description  Buffers ChatGPT streaming fetch responses and delivers them to the app only when complete, reducing token-by-token render churn.
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

  const CONFIG = {
    enabled: true,
    bufferAllEventStreams: true,
    showBadge: true,
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
    lastUrl: "",
    lastContentType: "",
    lastBufferedBytes: 0,
    lastError: "",
  };

  const originalFetch = page.fetch.bind(page);

  function log(...args) {
    if (CONFIG.debug) console.log("[cgpt-stream-buffer]", ...args);
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

  function installBadge() {
    if (!CONFIG.showBadge) return;
    if (!page.document || page.document.getElementById("cgpt-stream-buffer-badge")) return;

    const badge = page.document.createElement("div");
    badge.id = "cgpt-stream-buffer-badge";
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
    if (!CONFIG.showBadge) return;
    try {
      installBadge();
      const badge = page.document.getElementById("cgpt-stream-buffer-badge");
      if (badge) {
        badge.textContent = text || (
          "StreamBuffer " +
          (CONFIG.enabled ? "on" : "off") +
          " | fetch " + stats.fetchCalls +
          " | streams " + stats.streamResponses +
          " | buffered " + stats.buffered
        );
      }
    } catch {}
  }

  async function bufferResponse(url, response) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    updateBadge("StreamBuffer: buffering...");

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
          updateBadge("StreamBuffer: buffer limit; pass-through");
          return response;
        }

        chunks.push(value);
      }
    } catch (error) {
      stats.failed++;
      stats.lastError = String(error && error.message ? error.message : error);
      updateBadge("StreamBuffer: failed");
      log("buffer failed", error);
      throw error;
    }

    stats.buffered++;
    stats.lastBufferedBytes = total;
    updateBadge("StreamBuffer: delivering " + Math.round(total / 1024) + " KiB");
    log("buffered response", { url, total, chunks: chunks.length });

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

  page.cgptStreamBuffer = {
    config: CONFIG,
    stats,
    enable() {
      CONFIG.enabled = true;
      updateBadge();
      console.warn("[cgpt-stream-buffer] enabled");
    },
    disable() {
      CONFIG.enabled = false;
      updateBadge();
      console.warn("[cgpt-stream-buffer] disabled");
    },
    toggle() {
      CONFIG.enabled = !CONFIG.enabled;
      updateBadge();
      console.warn("[cgpt-stream-buffer] enabled=" + CONFIG.enabled);
    },
  };

  page.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyB") {
      event.preventDefault();
      page.cgptStreamBuffer.toggle();
    }
  }, true);

  const onReady = () => updateBadge();
  if (page.document?.readyState === "loading") {
    page.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  console.warn("[cgpt-stream-buffer] loaded. Event-stream fetch responses are buffered before ChatGPT receives them. Alt+Shift+B toggles.");
})();
