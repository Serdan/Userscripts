// ==UserScript==
// @name         ChatGPT Render Sink
// @namespace    local.chatgpt.render-sink
// @version      0.2.0
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
  const PANEL_ID = "cgpt-render-sink-panel";

  const CONFIG = {
    enabled: true,
    consumeRealStream: true,
    returnSyntheticDone: true,
    showBadge: true,
    showPanel: true,
    debug: false,
    maxCaptureChars: 500000,
    maxEvents: 2000,
    targetUrlPattern: /\/backend-api\/f\/conversation(?:\?|$|\/)/,
  };

  const stats = {
    fetchCalls: 0,
    sunk: 0,
    passed: 0,
    failed: 0,
    bytes: 0,
    events: 0,
    parsedEvents: 0,
    textEvents: 0,
    lastUrl: "",
    lastContentType: "",
    lastError: "",
    lastCapture: "",
    lastText: "",
    lastJSON: null,
    parsed: [],
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
          " | text " + stats.lastText.length +
          " | " + Math.round(stats.bytes / 1024) + " KiB"
        );
      }
    } catch {}
  }

  function installPanel() {
    if (!CONFIG.showPanel) return;
    if (!page.document || page.document.getElementById(PANEL_ID)) return;

    const panel = page.document.createElement("section");
    panel.id = PANEL_ID;
    panel.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "width:min(760px,calc(100vw - 24px))",
      "max-height:40vh",
      "z-index:2147483646",
      "display:flex",
      "flex-direction:column",
      "background:Canvas",
      "color:CanvasText",
      "border:1px solid color-mix(in srgb, CanvasText 25%, transparent)",
      "border-radius:10px",
      "box-shadow:0 8px 28px rgba(0,0,0,0.25)",
      "font:13px/1.45 system-ui,sans-serif",
      "contain:layout style paint",
    ].join(";");

    const header = page.document.createElement("div");
    header.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid color-mix(in srgb, CanvasText 18%, transparent);";

    const title = page.document.createElement("strong");
    title.textContent = "Render Sink Output";
    title.style.cssText = "font-size:12px;margin-right:auto;opacity:.8;";

    const copy = page.document.createElement("button");
    copy.textContent = "Copy";
    copy.style.cssText = "font-size:12px;padding:3px 7px;";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(stats.lastText || stats.lastCapture || ""); } catch {}
    });

    const hide = page.document.createElement("button");
    hide.textContent = "Hide";
    hide.style.cssText = "font-size:12px;padding:3px 7px;";
    hide.addEventListener("click", () => {
      CONFIG.showPanel = false;
      panel.remove();
    });

    const body = page.document.createElement("pre");
    body.id = PANEL_ID + "-body";
    body.style.cssText = [
      "white-space:pre-wrap",
      "overflow:auto",
      "margin:0",
      "padding:10px",
      "font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    ].join(";");

    header.append(title, copy, hide);
    panel.append(header, body);
    page.document.documentElement.appendChild(panel);
  }

  function updatePanel() {
    if (!CONFIG.showPanel) return;
    try {
      installPanel();
      const body = page.document.getElementById(PANEL_ID + "-body");
      if (body) {
        body.textContent = stats.lastText || "(no parsed text yet)";
        body.scrollTop = body.scrollHeight;
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

  function parseSSEEvent(raw) {
    const out = { event: "message", data: "" };
    const dataLines = [];

    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("event:")) out.event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    out.data = dataLines.join("\n");
    return out;
  }

  function extractTextFromObject(obj) {
    if (!obj || typeof obj !== "object") return "";

    const candidates = [
      obj.text,
      obj.delta,
      obj.v,
      obj.value,
      obj.message?.content?.parts?.join?.("\n"),
      obj.message?.metadata?.message_type === "next" ? obj.message?.content?.parts?.join?.("\n") : "",
      obj.args?.content,
      obj.args?.text,
      obj.content,
    ];

    for (const value of candidates) {
      if (typeof value === "string" && value) return value;
    }

    // Fallback for nested event payloads. Keep this bounded and conservative.
    for (const key of ["p", "o", "data", "payload", "message"]) {
      const nested = obj[key];
      if (nested && typeof nested === "object") {
        const found = extractTextFromObject(nested);
        if (found) return found;
      }
    }

    return "";
  }

  function processSSEEvent(raw) {
    if (!raw.trim()) return;
    stats.events++;

    const parsed = parseSSEEvent(raw);
    let json = null;
    let text = "";

    if (parsed.data && parsed.data !== "[DONE]") {
      try {
        json = JSON.parse(parsed.data);
        stats.lastJSON = json;
        text = extractTextFromObject(json);
      } catch {
        // Some event data is a JSON string or plain marker.
        try {
          const value = JSON.parse(parsed.data);
          if (typeof value === "string") text = value;
        } catch {}
      }
    }

    const entry = {
      event: parsed.event,
      dataPreview: parsed.data.slice(0, 500),
      json,
      text,
    };

    stats.parsed.push(entry);
    if (stats.parsed.length > CONFIG.maxEvents) stats.parsed.shift();
    stats.parsedEvents++;

    if (text) {
      stats.textEvents++;
      // Many ChatGPT events carry the full current assistant text, not a delta.
      if (text.length >= stats.lastText.length || text.startsWith(stats.lastText)) {
        stats.lastText = text;
      } else {
        stats.lastText += text;
      }
      updatePanel();
    }
  }

  async function consumeStream(url, response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    stats.lastCapture = "";
    stats.lastText = "";
    stats.lastJSON = null;
    stats.parsed = [];
    stats.bytes = 0;
    stats.events = 0;
    stats.parsedEvents = 0;
    stats.textEvents = 0;
    updatePanel();
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
        for (const raw of events) processSSEEvent(raw);
        updateBadge();
      }

      const tail = decoder.decode();
      maybeCaptureText(tail);
      pending += tail;
      if (pending.trim()) processSSEEvent(pending);

      stats.sunk++;
      updateBadge("RenderSink: stream consumed (" + Math.round(stats.bytes / 1024) + " KiB, " + stats.textEvents + " text events)");
      updatePanel();
      log("consumed", { url, bytes: stats.bytes, events: stats.events, textEvents: stats.textEvents });
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
    togglePanel() {
      CONFIG.showPanel = !CONFIG.showPanel;
      if (!CONFIG.showPanel) page.document?.getElementById(PANEL_ID)?.remove();
      else updatePanel();
    },
    lastCapture() {
      return stats.lastCapture;
    },
    lastText() {
      return stats.lastText;
    },
    parsedEvents() {
      return stats.parsed;
    },
    lastJSON() {
      return stats.lastJSON;
    },
    clearCapture() {
      stats.lastCapture = "";
      stats.lastText = "";
      stats.lastJSON = null;
      stats.parsed = [];
      stats.bytes = 0;
      stats.events = 0;
      stats.parsedEvents = 0;
      stats.textEvents = 0;
      updateBadge();
      updatePanel();
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
    if (event.altKey && event.shiftKey && event.code === "KeyP") {
      event.preventDefault();
      page.cgptRenderSink.togglePanel();
    }
  }, true);

  const onReady = () => {
    updateBadge();
    updatePanel();
  };
  if (page.document?.readyState === "loading") {
    page.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  console.warn("[cgpt-render-sink] loaded. Experimental. Alt+Shift+S toggles sink; Alt+Shift+V toggles badge; Alt+Shift+P toggles panel.");
})();
