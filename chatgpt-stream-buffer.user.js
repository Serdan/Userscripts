// ==UserScript==
// @name         ChatGPT Stream Buffer
// @namespace    local.chatgpt.stream-buffer
// @version      0.1.1
// @description  Buffers ChatGPT streaming fetch responses and delivers them to the app only when complete, reducing token-by-token render churn.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT_ID = "cgpt-stream-buffer-page-hook";

  if (document.getElementById(SCRIPT_ID)) return;

  const source = "(" + function cgptStreamBufferPageHook() {
    "use strict";

    if (window.__cgptStreamBufferInstalled) return;
    window.__cgptStreamBufferInstalled = true;

    const CONFIG = {
      enabled: true,
      debug: false,
      maxBufferBytes: 64 * 1024 * 1024,
      urlPatterns: [
        /\/backend-api\/conversation(?:\?|$|\/)/,
        /\/backend-api\/f\/.*conversation/,
        /\/backend-api\/codex\//,
        /\/backend-api\/responses(?:\?|$|\/)/,
      ],
      contentTypes: [
        "text/event-stream",
        "application/x-ndjson",
        "text/plain",
      ],
    };

    const originalFetch = window.fetch.bind(window);

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

    function shouldBufferResponse(url, response) {
      if (!CONFIG.enabled) return false;
      if (!shouldConsiderUrl(url)) return false;
      if (!response || !response.body) return false;

      const contentType = response.headers.get("content-type") || "";
      if (!contentType) return true;

      return CONFIG.contentTypes.some((type) => contentType.includes(type));
    }

    async function bufferResponse(url, response) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          total += value.byteLength || value.length || 0;

          if (total > CONFIG.maxBufferBytes) {
            log("buffer limit exceeded; falling back to original stream", { url, total });
            try { reader.releaseLock(); } catch {}
            return response;
          }

          chunks.push(value);
        }
      } catch (error) {
        log("buffer failed", error);
        throw error;
      }

      log("buffered response", { url, total, chunks: chunks.length });

      return new Response(new Blob(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    window.fetch = async function patchedFetch(input, init) {
      const url = requestUrl(input);
      const response = await originalFetch(input, init);

      if (!shouldBufferResponse(url, response)) return response;

      return bufferResponse(url, response);
    };

    window.cgptStreamBuffer = {
      config: CONFIG,
      enable() {
        CONFIG.enabled = true;
        console.warn("[cgpt-stream-buffer] enabled");
      },
      disable() {
        CONFIG.enabled = false;
        console.warn("[cgpt-stream-buffer] disabled");
      },
      toggle() {
        CONFIG.enabled = !CONFIG.enabled;
        console.warn("[cgpt-stream-buffer] enabled=" + CONFIG.enabled);
      },
    };

    window.addEventListener("keydown", (event) => {
      if (event.altKey && event.shiftKey && event.code === "KeyB") {
        event.preventDefault();
        window.cgptStreamBuffer.toggle();
      }
    }, true);

    console.warn("[cgpt-stream-buffer] loaded. Streaming fetch responses are buffered before ChatGPT receives them. Alt+Shift+B toggles.");
  }.toString() + ")();";

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.textContent = source;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
})();
