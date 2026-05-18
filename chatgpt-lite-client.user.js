// ==UserScript==
// @name         ChatGPT Lite Client
// @namespace    local.chatgpt.lite-client
// @version      0.1.0
// @description  Minimal same-origin ChatGPT client that runs on /lite-chat without booting the official React app.
// @match        https://chatgpt.com/lite-chat*
// @match        https://chat.openai.com/lite-chat*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const APP_ID = "cgpt-lite-client";
  const RECORDER_STORAGE_KEY = "cgptBackendRecorder.v1";
  const STATE_STORAGE_KEY = "cgptLiteClient.v1";
  const ENDPOINT = "/backend-api/f/conversation";

  window.stop?.();

  const DEFAULT_MODEL = "gpt-5-5-thinking";

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadRecorderRecords() {
    const records = loadJSON(RECORDER_STORAGE_KEY, []);
    return Array.isArray(records) ? records : [];
  }

  function latestConversationRecord() {
    return [...loadRecorderRecords()]
      .reverse()
      .find((record) => {
        return record &&
          record.method === "POST" &&
          /\/backend-api\/f\/conversation/.test(record.url || "") &&
          typeof record.requestBody === "string";
      }) || null;
  }

  function parseTemplateBody() {
    const record = latestConversationRecord();
    if (!record) return null;

    try {
      return JSON.parse(record.requestBody);
    } catch {
      return null;
    }
  }

  function safeHeadersFromRecord(record) {
    const allowed = [
      "chatgpt-account-id",
      "oai-client-build-number",
      "oai-client-version",
      "oai-device-id",
      "oai-language",
      "oai-session-id",
    ];

    const out = {
      "accept": "text/event-stream",
      "content-type": "application/json",
    };

    const headers = record?.requestHeaders || {};
    for (const key of allowed) {
      if (headers[key] && headers[key] !== "[redacted]") out[key] = headers[key];
    }

    return out;
  }

  function initialState() {
    const existing = loadJSON(STATE_STORAGE_KEY, null);
    if (existing && typeof existing === "object") return existing;

    return {
      conversationId: null,
      lastMessageId: uuid(),
      model: DEFAULT_MODEL,
      messages: [],
    };
  }

  let state = initialState();

  function persistState() {
    saveJSON(STATE_STORAGE_KEY, state);
  }

  function cssText(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(";");
  }

  function renderShell() {
    document.documentElement.innerHTML = `
      <head>
        <title>ChatGPT Lite</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body>
        <main id="${APP_ID}">
          <header id="topbar">
            <strong>ChatGPT Lite</strong>
            <span id="status">Idle</span>
            <button id="new-chat">New local chat</button>
            <button id="clear-log">Clear local log</button>
          </header>
          <section id="log" aria-live="polite"></section>
          <form id="composer">
            <textarea id="prompt" placeholder="Type a prompt. Ctrl/Cmd+Enter sends." autofocus></textarea>
            <div id="composer-row">
              <input id="model" title="Model" />
              <button id="send" type="submit">Send</button>
            </div>
          </form>
        </main>
      </body>
    `;

    const style = document.createElement("style");
    style.textContent = `
      :root { color-scheme: light dark; }
      html, body { margin: 0; min-height: 100%; background: Canvas; color: CanvasText; font: 14px/1.45 system-ui, sans-serif; }
      #${APP_ID} { display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; max-height: 100vh; }
      #topbar { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); contain: layout style paint; }
      #topbar strong { font-size: 14px; }
      #status { margin-right: auto; opacity: 0.7; font-size: 12px; }
      button, input, textarea { font: inherit; }
      button { padding: 6px 10px; }
      #log { overflow: auto; padding: 18px 12px 24px; display: flex; flex-direction: column; gap: 12px; contain: layout style paint; }
      .msg { max-width: 980px; width: min(980px, calc(100vw - 24px)); margin: 0 auto; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
      .role { display: block; font-weight: 700; font-size: 12px; opacity: 0.75; margin-bottom: 6px; }
      .user { border-color: color-mix(in srgb, CanvasText 22%, transparent); }
      .assistant { background: Canvas; }
      .error { border-color: #b00020; }
      #composer { padding: 12px; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); contain: layout style paint; }
      #prompt { display: block; box-sizing: border-box; width: min(980px, calc(100vw - 24px)); height: 120px; resize: vertical; margin: 0 auto 8px; padding: 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: Canvas; color: CanvasText; font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      #composer-row { width: min(980px, calc(100vw - 24px)); margin: 0 auto; display: flex; gap: 8px; }
      #model { flex: 1; padding: 6px 8px; }
    `;
    document.head.appendChild(style);

    document.getElementById("model").value = state.model || DEFAULT_MODEL;
  }

  function setStatus(text) {
    const el = document.getElementById("status");
    if (el) el.textContent = text;
  }

  function appendMessage(role, text, extraClass = "") {
    const log = document.getElementById("log");
    const msg = document.createElement("article");
    msg.className = `msg ${role} ${extraClass}`;

    const label = document.createElement("span");
    label.className = "role";
    label.textContent = role;
    msg.appendChild(label);

    const body = document.createElement("div");
    body.textContent = text;
    msg.appendChild(body);

    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function renderHistory() {
    const log = document.getElementById("log");
    log.textContent = "";
    for (const message of state.messages || []) {
      appendMessage(message.role, message.text || "");
    }
  }

  function makeUserMessage(prompt) {
    return {
      id: uuid(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      metadata: {},
    };
  }

  function makeRequestBody(prompt) {
    const template = parseTemplateBody() || {};
    const userMessage = makeUserMessage(prompt);

    const body = {
      action: "next",
      messages: [userMessage],
      conversation_id: state.conversationId || undefined,
      parent_message_id: state.lastMessageId || uuid(),
      model: document.getElementById("model")?.value || state.model || template.model || DEFAULT_MODEL,
      client_prepare_state: "none",
      timezone_offset_min: new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || template.timezone || "UTC",
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: {
        is_dark_mode: matchMedia?.("(prefers-color-scheme: dark)")?.matches || false,
        time_since_loaded: Math.round(performance.now() / 1000),
        page_height: window.innerHeight,
        page_width: window.innerWidth,
        pixel_ratio: window.devicePixelRatio || 1,
        screen_height: screen.height,
        screen_width: screen.width,
        app_name: location.hostname,
      },
    };

    if (template.conversation_mode?.kind === "gizmo_interaction") {
      body.conversation_mode = template.conversation_mode;
    }

    return body;
  }

  function extractTextFromSSELine(line) {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return null;

    try {
      const obj = JSON.parse(data);

      if (obj.message?.content?.parts?.length) {
        return obj.message.content.parts.join("\n");
      }

      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.v === "string") return obj.v;
      if (typeof obj.delta === "string") return obj.delta;

      if (obj.conversation_id && !state.conversationId) {
        state.conversationId = obj.conversation_id;
      }

      if (obj.message?.id) {
        state.lastMessageId = obj.message.id;
      }
    } catch {}

    return null;
  }

  async function readEventStream(response, outputEl) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latestText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const text = extractTextFromSSELine(line);
        if (text !== null) {
          latestText = text;
          outputEl.textContent = latestText;
        }
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const text = extractTextFromSSELine(line);
      if (text !== null) {
        latestText = text;
        outputEl.textContent = latestText;
      }
    }

    return latestText;
  }

  async function sendPrompt(prompt) {
    const record = latestConversationRecord();
    const headers = safeHeadersFromRecord(record);
    const body = makeRequestBody(prompt);

    setStatus("Sending...");

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const out = appendMessage("assistant", "");

    if (contentType.includes("text/event-stream") && response.body) {
      return readEventStream(response, out);
    }

    const text = await response.text();
    out.textContent = text;
    return text;
  }

  function wireEvents() {
    const form = document.getElementById("composer");
    const prompt = document.getElementById("prompt");
    const model = document.getElementById("model");

    model.addEventListener("input", () => {
      state.model = model.value.trim() || DEFAULT_MODEL;
      persistState();
    });

    prompt.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text) return;

      prompt.value = "";
      appendMessage("user", text);
      state.messages.push({ role: "user", text });
      persistState();

      try {
        const answer = await sendPrompt(text);
        state.messages.push({ role: "assistant", text: answer || "" });
        persistState();
        setStatus("Idle");
      } catch (error) {
        const msg = String(error?.message || error);
        appendMessage("error", msg, "error");
        setStatus("Error");
      }
    });

    document.getElementById("new-chat").addEventListener("click", () => {
      state = {
        conversationId: null,
        lastMessageId: uuid(),
        model: model.value.trim() || DEFAULT_MODEL,
        messages: [],
      };
      persistState();
      renderHistory();
      setStatus("New local chat");
    });

    document.getElementById("clear-log").addEventListener("click", () => {
      state.messages = [];
      persistState();
      renderHistory();
    });
  }

  function boot() {
    renderShell();
    renderHistory();
    wireEvents();

    if (!latestConversationRecord()) {
      setStatus("No recorder template found. Run Backend Recorder once in normal ChatGPT.");
    } else {
      setStatus("Ready");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
