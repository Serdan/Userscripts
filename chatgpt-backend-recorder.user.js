// ==UserScript==
// @name         ChatGPT Backend Recorder
// @namespace    local.chatgpt.backend-recorder
// @version      0.1.1
// @description  Records ChatGPT backend request/stream metadata locally so a future lite client can avoid loading the official app.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const STORAGE_KEY = "cgptBackendRecorder.v1";
  const MAX_RECORDS = 50;

  if (page.__cgptBackendRecorderInstalled) return;
  page.__cgptBackendRecorderInstalled = true;

  const CONFIG = {
    enabled: true,
    captureBodies: true,
    storeSensitiveHeaders: false,
    showBadge: true,
    debug: false,
    urlPatterns: [
      /\/backend-api\//,
      /\/conversation(?:\?|$|\/)/,
      /\/responses(?:\?|$|\/)/,
      /\/codex\//,
    ],
  };

  const SENSITIVE_HEADER_PATTERNS = [
    /^authorization$/i,
    /^cookie$/i,
    /^x-oai-is$/i,
    /^openai-sentinel-/i,
    /^cf-/i,
    /^sec-/i,
  ];

  const stats = {
    fetchCalls: 0,
    recorded: 0,
    lastMethod: "",
    lastUrl: "",
    lastStatus: 0,
    lastContentType: "",
    lastError: "",
  };

  const originalFetch = page.fetch.bind(page);

  function log(...args) {
    if (CONFIG.debug) console.log("[cgpt-backend-recorder]", ...args);
  }

  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === "string") return input.url;
    } catch {}
    return "";
  }

  function requestMethod(input, init) {
    return String(init?.method || input?.method || "GET").toUpperCase();
  }

  function shouldRecordUrl(url) {
    if (!url) return false;
    return CONFIG.urlPatterns.some((pattern) => pattern.test(url));
  }

  function loadRecords() {
    try {
      const parsed = JSON.parse(page.localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveRecords(records) {
    try {
      page.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
    } catch (error) {
      stats.lastError = String(error?.message || error);
    }
  }

  function isSensitiveHeader(key) {
    return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key));
  }

  function headersToObject(headersLike) {
    const out = {};

    try {
      const headers = new Headers(headersLike || {});
      for (const [key, value] of headers.entries()) {
        if (!CONFIG.storeSensitiveHeaders && isSensitiveHeader(key)) {
          out[key] = "[redacted]";
        } else {
          out[key] = value;
        }
      }
    } catch {}

    return out;
  }

  async function cloneBodyForStorage(input, init) {
    if (!CONFIG.captureBodies) return null;

    try {
      if (typeof init?.body === "string") return init.body;
      if (init?.body instanceof URLSearchParams) return init.body.toString();
      if (init?.body instanceof FormData) return "[FormData omitted]";
      if (init?.body instanceof Blob) return await init.body.text();
      if (input instanceof Request) return await input.clone().text();
    } catch (error) {
      return "[body capture failed: " + String(error?.message || error) + "]";
    }

    return null;
  }

  function sanitizeRecord(record) {
    return {
      ...record,
      requestHeaders: headersToObject(record.requestHeaders),
    };
  }

  function loadSanitizedRecords() {
    return loadRecords().map(sanitizeRecord);
  }

  function installBadge() {
    if (!CONFIG.showBadge) return;
    if (!page.document || page.document.getElementById("cgpt-backend-recorder-badge")) return;

    const badge = page.document.createElement("div");
    badge.id = "cgpt-backend-recorder-badge";
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
    if (!CONFIG.showBadge) return;

    try {
      installBadge();
      const badge = page.document.getElementById("cgpt-backend-recorder-badge");
      if (badge) {
        badge.textContent = text || (
          "BackendRecorder " +
          (CONFIG.enabled ? "on" : "off") +
          " | fetch " + stats.fetchCalls +
          " | recorded " + stats.recorded +
          " | last " + (stats.lastStatus || "-")
        );
      }
    } catch {}
  }

  async function recordFetch(input, init, response) {
    const url = requestUrl(input);
    const method = requestMethod(input, init);

    if (!CONFIG.enabled || !shouldRecordUrl(url)) return;

    stats.lastMethod = method;
    stats.lastUrl = url;
    stats.lastStatus = response?.status || 0;
    stats.lastContentType = response?.headers?.get?.("content-type") || "";

    const record = {
      at: new Date().toISOString(),
      url,
      method,
      status: stats.lastStatus,
      responseContentType: stats.lastContentType,
      requestHeaders: headersToObject(init?.headers || input?.headers),
      requestBody: await cloneBodyForStorage(input, init),
    };

    const records = loadRecords();
    records.push(record);
    saveRecords(records);

    stats.recorded++;
    updateBadge();
    log("recorded", record);
  }

  page.fetch = async function patchedFetch(input, init) {
    stats.fetchCalls++;

    const response = await originalFetch(input, init);

    try {
      await recordFetch(input, init, response.clone ? response.clone() : response);
    } catch (error) {
      stats.lastError = String(error?.message || error);
      log("record failed", error);
    }

    updateBadge();
    return response;
  };

  page.cgptBackendRecorder = {
    config: CONFIG,
    stats,
    loadRecords: loadSanitizedRecords,
    loadRawRecords: loadRecords,
    clear() {
      page.localStorage.removeItem(STORAGE_KEY);
      stats.recorded = 0;
      updateBadge();
    },
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
  };

  page.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyR") {
      event.preventDefault();
      page.cgptBackendRecorder.toggle();
    }
  }, true);

  const onReady = () => updateBadge();
  if (page.document?.readyState === "loading") {
    page.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  console.warn("[cgpt-backend-recorder] loaded. Records backend request shapes in localStorage. Alt+Shift+R toggles.");
})();
