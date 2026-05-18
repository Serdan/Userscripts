// ==UserScript==
// @name         ChatGPT Render Sink
// @namespace    local.chatgpt.render-sink
// @version      0.1.0
// @description  Experimental: let ChatGPT's official frontend send requests, but prevent the heavy response stream from reaching React.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (page.__cgptRenderSinkInstalled) return;
  page.__cgptRenderSinkInstalled = true;

  const BADGE_ID = "cgpt-render-sink-badge";

  const CONFIG = {
    enabled: true,
    consumeRealStream: true,
    returnSyntheticDone: true,
    showBadge: true,
    debug: false,
    maxCaptureChars: 200000,
    targetUrlPattern: /\/backend-api\/f\/conversation(?:\?|$|\/)/,
  };

  const stats = {
    fetchCalls: 0,
    sunk: 0,
    passed: 0,
    failed: 0,
    bytes: 0,
    events: 0,
    lastUrl: "",
    lastContentType: "",
    lastError: "",
    lastCapture: "",
  };

  const originalFetch = page.fetch.bind(page);

  function log(...args) {
    if (CONFIG.debug) console.log("[cgpt-render-sink]", ...args);
  }

  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === "string") return input.url;
    } catch {}
    return "";
  }

  function shouldSink(url, response) {
    if (!CONFIG.enabled) return false;
    if (!CONFIG.targetUrlPattern.test(url || "")) return false;
    if (!response || !response.body) return false;
    const type = response.headers.get("content-type") || "";
    return type.includes("text/event-stream");
  }

  function installBadge() {
    if (!CONFIG.showBadge) return;
    if (!page.document || page.document.getElementById(BADGE_ID)) return;

    const badge = page.document.createElement("div");
    badge.id = BADGE_ID;
    badge.style.cssText = [
      "position:fixed",
      "right:12px",
      "top:104px",
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
          "RenderSink " +
          (CONFIG.enabled ? "on" : "off") +
          " | sunk " + stats.sunk +
          " | events " + stats.events +
          " | " + Math.round(stats.bytes / 1024) + " KiB"
        );
      }
    } catch {}
  }

  function makeSyntheticDoneResponse(response) {
    const body = "data: [DONE]\n\n";
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function maybeCaptureText(chunkText) {
    if (!chunkText) return;
    const remaining = CONFIG.maxCaptureChars - stats.lastCapture.length;
    if (remaining <= 0) return;
    stats.lastCapture += chunkText.slice(0, remaining);
  }

  async function consumeStream(url, response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    updateBadge("RenderSink: consuming real stream...");

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        stats.bytes += value.byteLength || value.length || 0;
        const text = decoder.decode(value, { stream: true });
        maybeCaptureText(text);

        pending += text;
        const events = pending.split("\n\n");
        pending = events.pop() || "";
        stats.events += Math.max(0, events.length);
        updateBadge();
      }

      const tail = decoder.decode();
      maybeCaptureText(tail);
      stats.sunk++;
      updateBadge("RenderSink: stream consumed (" + Math.round(stats.bytes / 1024) + " KiB)");
      log("consumed", { url, bytes: stats.bytes, events: stats.events });
    } catch (error) {
      stats.failed++;
      stats.lastError = String(error?.message || error);
      updateBadge("RenderSink: consume failed");
      log("consume failed", error);
    }
  }

  page.fetch = async function patchedFetch(input, init) {
    stats.fetchCalls++;
    const url = requestUrl(input);
    stats.lastUrl = url;

    const response = await originalFetch(input, init);
    stats.lastContentType = response.headers.get("content-type") || "";

    if (!shouldSink(url, response)) {
      stats.passed++;
      updateBadge();
      return response;
    }

    if (CONFIG.consumeRealStream) {
      consumeStream(url, response.clone ? response.clone() : response);
    }

    if (CONFIG.returnSyntheticDone) {
      updateBadge("RenderSink: returning synthetic DONE to React");
      return makeSyntheticDoneResponse(response);
    }

    return response;
  };

  page.cgptRenderSink = {
    config: CONFIG,
    stats,
    enable() {
      CONFIG.enabled = true;
      updateBadge();
    },
    disable() {
      CONFIG.enabled = false;
      updateBadge();
    },
    toggle() {
      CONFIG.enabled = !CONFIG.enabled;
      updateBadge();
    },
    toggleBadge() {
      CONFIG.showBadge = !CONFIG.showBadge;
      updateBadge();
    },
    lastCapture() {
      return stats.lastCapture;
    },
    clearCapture() {
      stats.lastCapture = "";
      stats.bytes = 0;
      stats.events = 0;
      updateBadge();
    },
  };

  page.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyS") {
      event.preventDefault();
      page.cgptRenderSink.toggle();
    }
    if (event.altKey && event.shiftKey && event.code === "KeyV") {
      event.preventDefault();
      page.cgptRenderSink.toggleBadge();
    }
  }, true);

  const onReady = () => updateBadge();
  if (page.document?.readyState === "loading") {
    page.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  console.warn("[cgpt-render-sink] loaded. Experimental. Alt+Shift+S toggles sink; Alt+Shift+V toggles badge.");
})();
