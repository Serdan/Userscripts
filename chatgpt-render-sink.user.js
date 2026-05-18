// ==UserScript==
// @name         ChatGPT Render Sink
// @namespace    local.chatgpt.render-sink
// @version      0.4.0
// @description  Experimental: let ChatGPT's official frontend send requests, but prevent heavy response deltas from reaching React.
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
    transformStreams: true,
    passControlEventsToReact: true,
    passDoneToReact: true,
    showBadge: true,
    showPanel: true,
    debug: false,
    maxCaptureChars: 500000,
    maxEvents: 2000,
    targetUrlPatterns: [
      /\/backend-api\/f\/conversation(?:\?|$|\/)/,
      /\/backend-api\/conversation\/[^/]+(?:\?|$|\/)/,
      /\/backend-api\/responses(?:\?|$|\/)/,
      /\/backend-api\/codex\//,
    ],
    excludedUrlPatterns: [
      /\/backend-api\/files\//,
      /\/backend-api\/file\//,
      /\/backend-api\/conversation\/[^/]+\/textdocs/,
      /\/backend-api\/aip\//,
      /\/backend-api\/sentinel\//,
      /\/backend-api\/settings\//,
      /\/backend-api\/checkout_/,
      /\/backend-api\/hermes\//,
    ],
  };

  const stats = {
    fetchCalls: 0,
    transformed: 0,
    passed: 0,
    failed: 0,
    bytes: 0,
    events: 0,
    ndjsonRecords: 0,
    parsedEvents: 0,
    textEvents: 0,
    controlEventsPassed: 0,
    eventsSwallowed: 0,
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

  function urlMatches(url, patterns) {
    return patterns.some((pattern) => pattern.test(url || ""));
  }

  function shouldSink(url, response) {
    if (!CONFIG.enabled) return false;
    if (!urlMatches(url, CONFIG.targetUrlPatterns)) return false;
    if (urlMatches(url, CONFIG.excludedUrlPatterns)) return false;
    if (!response || !response.body) return false;
    const type = response.headers.get("content-type") || "";
    return type.includes("text/event-stream") || type.includes("application/x-ndjson") || type.includes("application/jsonl");
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
          " | tx " + stats.transformed +
          " | events " + stats.events +
          " | text " + stats.lastText.length +
          " | pass " + stats.controlEventsPassed +
          " | drop " + stats.eventsSwallowed
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

  function isPatchOperationObject(obj) {
    return Boolean(
      obj &&
      typeof obj === "object" &&
      typeof obj.o === "string" &&
      ["add", "append", "patch", "replace", "remove"].includes(obj.o) &&
      ("p" in obj || "v" in obj)
    );
  }

  function extractPatchValueText(obj) {
    if (!isPatchOperationObject(obj)) return "";
    const path = Array.isArray(obj.p) ? obj.p.join("/") : String(obj.p || "");
    const value = obj.v;

    if (typeof value === "string" && /message|content|parts|text|body|output/i.test(path)) {
      return value;
    }

    if (value && typeof value === "object") {
      return extractTextFromObject(value);
    }

    return "";
  }

  function extractTextFromObject(obj) {
    if (!obj || typeof obj !== "object") return "";

    const patchText = extractPatchValueText(obj);
    if (patchText) return patchText;

    const candidates = [
      obj.text,
      obj.delta,
      obj.value,
      obj.message?.content?.parts?.join?.("\n"),
      obj.args?.content,
      obj.args?.text,
      obj.content,
    ];

    for (const value of candidates) {
      if (typeof value === "string" && value) return value;
    }

    for (const key of ["data", "payload", "message", "item", "delta", "v"]) {
      const nested = obj[key];
      if (nested && typeof nested === "object") {
        const found = extractTextFromObject(nested);
        if (found) return found;
      }
    }

    return "";
  }

  function storeParsedEntry(entry) {
    stats.parsed.push(entry);
    if (stats.parsed.length > CONFIG.maxEvents) stats.parsed.shift();
    stats.parsedEvents++;
  }

  function acceptText(text) {
    if (!text) return;
    stats.textEvents++;
    if (text.length >= stats.lastText.length || text.startsWith(stats.lastText)) {
      stats.lastText = text;
    } else {
      stats.lastText += text;
    }
    updatePanel();
  }

  function processParsedPayload(kind, data, rawForPreview = "") {
    let json = null;
    let text = "";

    if (data && data !== "[DONE]") {
      try {
        json = JSON.parse(data);
        stats.lastJSON = json;
        text = extractTextFromObject(json);
      } catch {
        try {
          const value = JSON.parse(data);
          if (typeof value === "string" && kind !== "delta_encoding") text = value;
        } catch {}
      }
    }

    const entry = {
      event: kind,
      dataPreview: String(data || rawForPreview).slice(0, 500),
      json,
      text,
    };
    storeParsedEntry(entry);
    if (text && kind !== "delta_encoding") acceptText(text);
    return { json, text, entry };
  }

  function processSSEEvent(raw) {
    if (!raw.trim()) return { parsed: null, text: "", passToReact: false, raw };
    stats.events++;

    const parsed = parseSSEEvent(raw);
    const payload = processParsedPayload(parsed.event, parsed.data, raw);

    return {
      parsed,
      json: payload.json,
      text: payload.text,
      passToReact: shouldPassEventToReact(parsed, payload.json, payload.text),
      raw,
    };
  }

  function processNDJSONLine(raw) {
    const line = raw.trim();
    if (!line) return { passToReact: false, raw };
    stats.ndjsonRecords++;
    const payload = processParsedPayload("ndjson", line, raw);
    return {
      parsed: { event: "ndjson", data: line },
      json: payload.json,
      text: payload.text,
      passToReact: shouldPassEventToReact({ event: "ndjson", data: line }, payload.json, payload.text),
      raw,
    };
  }

  function shouldPassEventToReact(parsed, json, text) {
    if (!parsed) return false;
    if (parsed.data === "[DONE]") return CONFIG.passDoneToReact;
    if (!CONFIG.passControlEventsToReact) return false;

    if (parsed.event === "delta_encoding") return true;
    if (json?.type === "resume_conversation_token") return true;

    if (!text && parsed.data.length < 1200) {
      const type = json?.type || "";
      if (/token|resume|control|meta|status|heartbeat|ping|ack/i.test(type)) return true;
    }

    return false;
  }

  function makeTransformedResponse(response, contentType) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const isEventStream = contentType.includes("text/event-stream");
    let pending = "";

    stats.lastCapture = "";
    stats.lastText = "";
    stats.lastJSON = null;
    stats.parsed = [];
    stats.bytes = 0;
    stats.events = 0;
    stats.ndjsonRecords = 0;
    stats.parsedEvents = 0;
    stats.textEvents = 0;
    stats.controlEventsPassed = 0;
    stats.eventsSwallowed = 0;
    updatePanel();
    updateBadge("RenderSink: transforming stream...");

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              const tail = decoder.decode();
              if (tail) {
                maybeCaptureText(tail);
                pending += tail;
              }
              flushPending(controller, true);
              controller.close();
              stats.transformed++;
              updateBadge();
              updatePanel();
              return;
            }

            if (!value) continue;
            stats.bytes += value.byteLength || value.length || 0;
            const text = decoder.decode(value, { stream: true });
            maybeCaptureText(text);
            pending += text;
            flushPending(controller, false);
            updateBadge();
            return;
          }
        } catch (error) {
          stats.failed++;
          stats.lastError = String(error?.message || error);
          updateBadge("RenderSink: transform failed");
          log("transform failed", error);
          controller.error(error);
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch {}
      },
    });

    function flushPending(controller, final) {
      if (isEventStream) {
        const events = pending.split("\n\n");
        pending = final ? "" : (events.pop() || "");
        for (const raw of events) emitEvent(controller, raw, "sse");
        if (final && pending.trim()) emitEvent(controller, pending, "sse");
      } else {
        const lines = pending.split(/\r?\n/);
        pending = final ? "" : (lines.pop() || "");
        for (const raw of lines) emitEvent(controller, raw, "ndjson");
        if (final && pending.trim()) emitEvent(controller, pending, "ndjson");
      }
    }

    function emitEvent(controller, raw, kind) {
      const result = kind === "sse" ? processSSEEvent(raw) : processNDJSONLine(raw);
      if (result.passToReact) {
        stats.controlEventsPassed++;
        const suffix = kind === "sse" ? "\n\n" : "\n";
        controller.enqueue(encoder.encode(raw + suffix));
      } else {
        stats.eventsSwallowed++;
      }
    }

    return new Response(stream, {
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
    const contentType = response.headers.get("content-type") || "";
    stats.lastContentType = contentType;

    if (!shouldSink(url, response)) {
      stats.passed++;
      updateBadge();
      return response;
    }

    if (CONFIG.transformStreams) {
      return makeTransformedResponse(response, contentType);
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
      stats.ndjsonRecords = 0;
      stats.parsedEvents = 0;
      stats.textEvents = 0;
      stats.controlEventsPassed = 0;
      stats.eventsSwallowed = 0;
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

  console.warn("[cgpt-render-sink] loaded. Experimental transform mode. Alt+Shift+S toggles sink; Alt+Shift+V toggles badge; Alt+Shift+P toggles panel.");
})();
