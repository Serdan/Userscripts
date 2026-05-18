// ==UserScript==
// @name         ChatGPT Render Sink
// @namespace    local.chatgpt.render-sink
// @version      0.9.1
// @description  Render plain ChatGPT text deltas in a lightweight transcript while passing safe structured/control events to the official UI.
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

  const PANEL_ID = "cgpt-render-sink-panel";
  const BADGE_ID = "cgpt-render-sink-badge";

  const CONFIG = {
    enabled: true,
    showPanel: true,
    showBadge: false,
    passDoneToReact: true,
    passStructuredObjectsToReact: true,
    passUnknownPatchFragmentsToReact: false,
    panelUpdateMs: 120,
    maxTurns: 30,
    maxEvents: 2000,
    maxCaptureChars: 500000,
    targetUrlPatterns: [
      /\/ces\/v1\/m(?:\?|$|\/)/,
      /\/backend-api\/f\/conversation(?:\?|$|\/)/,
      /\/backend-api\/conversation\/[^/]+(?:\?|$|\/)/,
      /\/backend-api\/responses(?:\?|$|\/)/,
      /\/backend-api\/codex\//,
    ],
    excludedUrlPatterns: [
      /\/ces\/v1\/rgstr(?:\?|$|\/)/,
      /\/ces\/statsc(?:\?|$|\/)/,
      /\/ces\/statsc\//,
      /\/ces\/v1\/telemetry(?:\?|$|\/)/,
      /\/ces\/v1\/telemetry\//,
      /\/backend-api\/files?\//,
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
    parsedEvents: 0,
    textEvents: 0,
    totalTextEvents: 0,
    controlEventsPassed: 0,
    eventsSwallowed: 0,
    interactiveEventsPassed: 0,
    malformedEventsBlocked: 0,
    patchFragmentsBlocked: 0,
    lastUrl: "",
    lastContentType: "",
    lastError: "",
    lastCapture: "",
    lastText: "",
    lastStableText: "",
    lastJSON: null,
    parsed: [],
  };

  const transcript = { turns: [], current: null };
  const streamState = { currentContentPath: "" };
  const originalFetch = page.fetch.bind(page);
  let panelTimer = 0;
  let badgeTimer = 0;

  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === "string") return input.url;
    } catch {}
    return "";
  }

  function matches(url, patterns) {
    return patterns.some((pattern) => pattern.test(url || ""));
  }

  function shouldSink(url, response) {
    if (!CONFIG.enabled) return false;
    if (!matches(url, CONFIG.targetUrlPatterns)) return false;
    if (matches(url, CONFIG.excludedUrlPatterns)) return false;
    if (!response || !response.body) return false;
    const type = response.headers.get("content-type") || "";
    return type.includes("text/event-stream") || type.includes("text/plain") || type.includes("application/x-ndjson") || type.includes("application/jsonl");
  }

  function trimTurns() {
    while (transcript.turns.length > CONFIG.maxTurns) transcript.turns.shift();
  }

  function ensureTurn() {
    if (transcript.current) return transcript.current;
    const turn = { id: String(Date.now()), user: "", assistant: "", status: "streaming", note: "" };
    transcript.current = turn;
    transcript.turns.push(turn);
    trimTurns();
    return turn;
  }

  function addUserText(text) {
    if (!text) return;
    const last = transcript.turns[transcript.turns.length - 1];
    if (last && !last.assistant && last.user === text) {
      transcript.current = last;
      return;
    }
    const turn = { id: String(Date.now()), user: text, assistant: "", status: "streaming", note: "" };
    transcript.current = turn;
    transcript.turns.push(turn);
    trimTurns();
    schedulePanel();
  }

  function addAssistantText(text) {
    if (!text) return;
    const turn = ensureTurn();
    turn.assistant = stats.lastText;
    turn.status = "streaming";
    schedulePanel();
  }

  function markInteractive() {
    const turn = ensureTurn();
    if (!turn.note) turn.note = "Structured / interactive content passed to the official ChatGPT UI.";
    schedulePanel();
  }

  function finishTurn() {
    if (transcript.current) {
      transcript.current.assistant = stats.lastText || transcript.current.assistant;
      transcript.current.status = "done";
    }
    schedulePanel();
  }

  function installBadge() {
    if (!CONFIG.showBadge || page.document?.getElementById(BADGE_ID)) return;
    const el = page.document.createElement("div");
    el.id = BADGE_ID;
    el.style.cssText = "position:fixed;right:12px;top:104px;z-index:2147483647;font:12px system-ui,sans-serif;padding:6px 8px;border-radius:8px;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);box-shadow:0 6px 20px rgba(0,0,0,.2);opacity:.85;pointer-events:none;contain:layout style paint";
    page.document.documentElement.appendChild(el);
  }

  function updateBadge(text) {
    if (!CONFIG.showBadge) {
      page.document?.getElementById(BADGE_ID)?.remove();
      return;
    }
    installBadge();
    const el = page.document.getElementById(BADGE_ID);
    if (el) el.textContent = text || `RenderSink ${CONFIG.enabled ? "on" : "off"} | tx ${stats.transformed} | text ${stats.lastText.length} | pass ${stats.controlEventsPassed} | drop ${stats.eventsSwallowed}`;
  }

  function scheduleBadge() {
    if (badgeTimer) return;
    badgeTimer = page.setTimeout(() => {
      badgeTimer = 0;
      updateBadge();
    }, 250);
  }

  function installPanel() {
    if (!CONFIG.showPanel || page.document?.getElementById(PANEL_ID)) return;
    const panel = page.document.createElement("section");
    panel.id = PANEL_ID;
    panel.style.cssText = "position:fixed;right:12px;bottom:12px;width:min(900px,calc(100vw - 24px));height:min(72vh,760px);z-index:2147483646;display:flex;flex-direction:column;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);font:13px/1.45 system-ui,sans-serif;contain:layout style paint";

    const header = page.document.createElement("div");
    header.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid color-mix(in srgb, CanvasText 18%, transparent);";

    const title = page.document.createElement("strong");
    title.textContent = "Render Sink Transcript";
    title.style.cssText = "font-size:12px;margin-right:auto;opacity:.8;";

    const copy = page.document.createElement("button");
    copy.textContent = "Copy latest";
    copy.style.cssText = "font-size:12px;padding:3px 7px;";
    copy.addEventListener("click", async () => {
      const last = transcript.turns[transcript.turns.length - 1];
      const text = last?.assistant || stats.lastText || stats.lastStableText || stats.lastCapture || "";
      try { await navigator.clipboard.writeText(text); } catch {}
    });

    const clear = page.document.createElement("button");
    clear.textContent = "Clear";
    clear.style.cssText = "font-size:12px;padding:3px 7px;";
    clear.addEventListener("click", () => {
      transcript.turns = [];
      transcript.current = null;
      stats.lastText = "";
      stats.lastStableText = "";
      updatePanelNow();
    });

    const hide = page.document.createElement("button");
    hide.textContent = "Hide";
    hide.style.cssText = "font-size:12px;padding:3px 7px;";
    hide.addEventListener("click", () => {
      CONFIG.showPanel = false;
      panel.remove();
    });

    const body = page.document.createElement("div");
    body.id = PANEL_ID + "-body";
    body.style.cssText = "overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px;min-height:0;";

    header.append(title, copy, clear, hide);
    panel.append(header, body);
    page.document.documentElement.appendChild(panel);
  }

  function renderBlock(label, text, kind) {
    const article = page.document.createElement("article");
    article.style.cssText = `border:1px solid color-mix(in srgb, CanvasText 15%, transparent);border-radius:8px;padding:8px 10px;background:${kind === "user" ? "color-mix(in srgb, CanvasText 6%, Canvas)" : "Canvas"};contain:layout style paint`;
    const heading = page.document.createElement("div");
    heading.textContent = label;
    heading.style.cssText = "font:600 11px system-ui,sans-serif;opacity:.65;margin-bottom:4px;";
    const body = page.document.createElement("pre");
    body.textContent = text || "";
    body.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
    article.append(heading, body);
    return article;
  }

  function updatePanelNow() {
    panelTimer = 0;
    if (!CONFIG.showPanel) return;
    installPanel();
    const body = page.document.getElementById(PANEL_ID + "-body");
    if (!body) return;
    body.textContent = "";
    if (!transcript.turns.length) {
      const empty = page.document.createElement("div");
      empty.textContent = "No captured response yet.";
      empty.style.cssText = "opacity:.65;padding:8px;";
      body.appendChild(empty);
    } else {
      for (const turn of transcript.turns) {
        const wrap = page.document.createElement("section");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
        if (turn.user) wrap.appendChild(renderBlock("You", turn.user, "user"));
        if (turn.assistant) wrap.appendChild(renderBlock(turn.status === "done" ? "Assistant" : "Assistant streaming", turn.assistant, "assistant"));
        if (turn.note) wrap.appendChild(renderBlock("Official UI", turn.note, "note"));
        body.appendChild(wrap);
      }
    }
    body.scrollTop = body.scrollHeight;
  }

  function schedulePanel() {
    if (!CONFIG.showPanel || panelTimer) return;
    panelTimer = page.setTimeout(updatePanelNow, CONFIG.panelUpdateMs);
  }

  function capture(text) {
    if (!text) return;
    const remain = CONFIG.maxCaptureChars - stats.lastCapture.length;
    if (remain > 0) stats.lastCapture += text.slice(0, remain);
  }

  function parseSSE(raw) {
    const out = { event: "message", data: "" };
    const lines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("event:")) out.event = line.slice(6).trim();
      else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
    }
    out.data = lines.join("\n");
    return out;
  }

  function normalizePath(path) {
    if (Array.isArray(path)) return "/" + path.join("/");
    return String(path || "");
  }

  function isContentPath(path) {
    return /\/message\/content\/parts(?:\/|$)|\/content\/parts(?:\/|$)|\/text(?:\/|$)|\/body(?:\/|$)|\/output(?:\/|$)/i.test(normalizePath(path));
  }

  function rememberPath(path) {
    const normalized = normalizePath(path);
    if (isContentPath(normalized)) streamState.currentContentPath = normalized;
  }

  function isPatchObject(json) {
    return Boolean(json && typeof json === "object" && typeof json.o === "string" && ("p" in json || "v" in json));
  }

  function extractUserText(json) {
    const msg = json?.input_message || json?.message || json?.v?.message;
    if (msg?.author?.role !== "user") return "";
    const parts = msg.content?.parts;
    return Array.isArray(parts) ? parts.join("\n") : "";
  }

  function extractTextDelta(json) {
    if (!json || typeof json !== "object") return "";

    if (typeof json.o === "string" && ["add", "append", "patch", "replace"].includes(json.o)) {
      const path = normalizePath(json.p || "");
      if (path) rememberPath(path);
      const effectivePath = path || streamState.currentContentPath;
      const value = json.v;
      if (Array.isArray(value) && json.o === "patch") return value.map(extractTextDelta).filter(Boolean).join("");
      if (typeof value === "string") return isContentPath(effectivePath) ? value : "";
      if (value && typeof value === "object") return extractTextDelta(value);
      return "";
    }

    if (typeof json.v === "string" && streamState.currentContentPath && isContentPath(streamState.currentContentPath)) return json.v;
    return "";
  }

  function hasStructuredMessage(json) {
    const msg = json?.message || json?.v?.message || json?.input_message;
    if (!msg || typeof msg !== "object") return false;
    const contentType = msg.content?.content_type;
    if (contentType && contentType !== "text") return true;
    if (msg.channel && msg.channel !== "final") return true;
    if (msg.recipient && msg.recipient !== "all") return true;
    return false;
  }

  function hasExplicitInteractiveFields(json) {
    if (!json || typeof json !== "object") return false;
    const type = String(json.type || "");
    if (/tool|connector|oauth|authorization|approval|permission|consent|widget|card|action/i.test(type)) return true;
    if (hasStructuredMessage(json)) return true;
    const value = json.v;
    if (value && typeof value === "object" && hasStructuredMessage(value)) return true;
    return false;
  }

  function recordParsed(kind, data, json, text, passToReact, reason) {
    stats.parsed.push({ event: kind, dataPreview: String(data || "").slice(0, 500), json, text, passToReact, reason });
    if (stats.parsed.length > CONFIG.maxEvents) stats.parsed.shift();
    stats.parsedEvents++;
  }

  function acceptText(text) {
    stats.textEvents++;
    stats.totalTextEvents++;
    if (text.length >= stats.lastText.length && text.startsWith(stats.lastText)) stats.lastText = text;
    else stats.lastText += text;
    stats.lastStableText = stats.lastText;
    addAssistantText(text);
  }

  function processPayload(kind, data) {
    let json = null;
    let text = "";
    let passToReact = false;
    let reason = "blocked";

    if (data === "[DONE]") {
      finishTurn();
      passToReact = CONFIG.passDoneToReact;
      reason = "done";
      recordParsed(kind, data, null, "", passToReact, reason);
      return { passToReact };
    }

    try { json = data ? JSON.parse(data) : null; } catch {}

    if (!json || typeof json !== "object") {
      if (kind === "delta_encoding") {
        passToReact = true;
        reason = "delta-encoding-control";
      } else {
        stats.malformedEventsBlocked++;
        passToReact = false;
        reason = "non-object-blocked";
      }
      recordParsed(kind, data, json, "", passToReact, reason);
      return { passToReact };
    }

    stats.lastJSON = json;

    const userText = extractUserText(json);
    if (userText) addUserText(userText);

    text = extractTextDelta(json);
    if (text) {
      passToReact = false;
      reason = "text-delta-sunk";
      acceptText(text);
    } else if (hasExplicitInteractiveFields(json)) {
      passToReact = true;
      reason = "interactive-structured";
      stats.interactiveEventsPassed++;
      markInteractive();
    } else if (isPatchObject(json)) {
      passToReact = CONFIG.passUnknownPatchFragmentsToReact;
      reason = passToReact ? "unknown-patch-passed" : "unknown-patch-blocked";
      if (!passToReact) stats.patchFragmentsBlocked++;
    } else if (json.type === "resume_conversation_token") {
      passToReact = true;
      reason = "resume-token";
    } else if (json.type === "message_stream_complete") {
      finishTurn();
      passToReact = true;
      reason = "stream-complete";
    } else {
      passToReact = CONFIG.passStructuredObjectsToReact;
      reason = passToReact ? "structured-object" : "structured-object-blocked";
    }

    recordParsed(kind, data, json, text, passToReact, reason);
    return { passToReact };
  }

  function processSSE(raw) {
    if (!raw.trim()) return { passToReact: false };
    stats.events++;
    const parsed = parseSSE(raw);
    return processPayload(parsed.event, parsed.data);
  }

  function processLine(raw) {
    const line = raw.trim();
    if (!line) return { passToReact: false };
    stats.events++;
    return processPayload("ndjson", line);
  }

  function makeTransformedResponse(response, contentType) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const isEventStream = contentType.includes("text/event-stream") || contentType.includes("text/plain");
    let pending = "";
    let controllerRef = null;
    let closed = false;

    stats.lastCapture = "";
    stats.lastJSON = null;
    stats.parsed = [];
    stats.bytes = 0;
    stats.events = 0;
    stats.parsedEvents = 0;
    stats.textEvents = 0;
    stats.controlEventsPassed = 0;
    stats.eventsSwallowed = 0;
    stats.interactiveEventsPassed = 0;
    stats.malformedEventsBlocked = 0;
    stats.patchFragmentsBlocked = 0;
    streamState.currentContentPath = "";

    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        pump();
      },
      cancel(reason) {
        closed = true;
        try { reader.cancel(reason); } catch {}
      },
    });

    async function pump() {
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) {
              capture(tail);
              pending += tail;
            }
            flush(true);
            closed = true;
            try { controllerRef.close(); } catch {}
            stats.transformed++;
            updateBadge();
            updatePanelNow();
            return;
          }
          if (!value) continue;
          stats.bytes += value.byteLength || value.length || 0;
          const text = decoder.decode(value, { stream: true });
          capture(text);
          pending += text;
          flush(false);
          scheduleBadge();
        }
      } catch (error) {
        closed = true;
        stats.failed++;
        stats.lastError = String(error?.message || error);
        try { controllerRef.error(error); } catch {}
      }
    }

    function flush(final) {
      if (isEventStream) {
        const events = pending.split("\n\n");
        pending = final ? "" : (events.pop() || "");
        for (const raw of events) emit(raw, "sse");
        if (final && pending.trim()) emit(pending, "sse");
      } else {
        const lines = pending.split(/\r?\n/);
        pending = final ? "" : (lines.pop() || "");
        for (const raw of lines) emit(raw, "line");
        if (final && pending.trim()) emit(pending, "line");
      }
    }

    function emit(raw, kind) {
      const result = kind === "sse" ? processSSE(raw) : processLine(raw);
      if (result.passToReact && !closed) {
        stats.controlEventsPassed++;
        try { controllerRef.enqueue(encoder.encode(raw + (kind === "sse" ? "\n\n" : "\n"))); } catch {}
      } else {
        stats.eventsSwallowed++;
      }
    }

    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
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
      scheduleBadge();
      return response;
    }
    return makeTransformedResponse(response, contentType);
  };

  page.cgptRenderSink = {
    config: CONFIG,
    stats,
    transcript,
    enable() { CONFIG.enabled = true; updateBadge(); },
    disable() { CONFIG.enabled = false; updateBadge(); },
    toggle() { CONFIG.enabled = !CONFIG.enabled; updateBadge(); },
    toggleBadge() { CONFIG.showBadge = !CONFIG.showBadge; updateBadge(); },
    togglePanel() { CONFIG.showPanel = !CONFIG.showPanel; if (!CONFIG.showPanel) page.document?.getElementById(PANEL_ID)?.remove(); else updatePanelNow(); },
    lastCapture() { return stats.lastCapture; },
    lastText() { return stats.lastText; },
    parsedEvents() { return stats.parsed; },
    lastJSON() { return stats.lastJSON; },
    clearCapture() {
      stats.lastCapture = "";
      stats.lastText = "";
      stats.lastStableText = "";
      stats.lastJSON = null;
      stats.parsed = [];
      transcript.turns = [];
      transcript.current = null;
      streamState.currentContentPath = "";
      updatePanelNow();
    },
  };

  page.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyS") { event.preventDefault(); page.cgptRenderSink.toggle(); }
    if (event.altKey && event.shiftKey && event.code === "KeyV") { event.preventDefault(); page.cgptRenderSink.toggleBadge(); }
    if (event.altKey && event.shiftKey && event.code === "KeyP") { event.preventDefault(); page.cgptRenderSink.togglePanel(); }
  }, true);

  const ready = () => { updateBadge(); updatePanelNow(); };
  if (page.document?.readyState === "loading") page.document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();

  console.warn("[cgpt-render-sink] loaded. Safe fragment mode. Alt+Shift+S toggles sink; Alt+Shift+V toggles badge; Alt+Shift+P toggles panel.");
})();
