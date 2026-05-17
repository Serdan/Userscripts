// ==UserScript==
// @name         ChatGPT Perf Flight Recorder
// @namespace    local.chatgpt.perf
// @version      0.1.0
// @description  Local-only flight recorder for ChatGPT renderer stalls, with a collector page for retrieving dumps after killing a laggy tab.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "__chatgptPerfEvents_v1";
  const MAX_EVENTS = 500;
  const START = performance.now();

  function now() {
    return Math.round(performance.now() - START);
  }

  function loadEvents() {
    try {
      const events = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }

  function saveEvents(events) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
    } catch {
      // Storage may be full or unavailable. This script must never make the app worse.
    }
  }

  function getMemory() {
    if (!performance.memory) return null;

    return {
      used_mb: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
      total_mb: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
      limit_mb: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024),
    };
  }

  function selectorCounts() {
    const selectors = [
      "main",
      "[role='main']",
      "[data-testid]",
      "[data-message-author-role]",
      "pre",
      "code",
      "table",
      "textarea",
      "[contenteditable='true']",
      "button",
      "svg",
      "canvas",
      "iframe",
    ];

    return Object.fromEntries(
      selectors.map((selector) => {
        try {
          return [selector, document.querySelectorAll(selector).length];
        } catch {
          return [selector, null];
        }
      })
    );
  }

  function add(type, data = {}) {
    const events = loadEvents();

    events.push({
      t_ms: now(),
      wall_time: new Date().toISOString(),
      type,
      path: location.pathname,
      ...data,
    });

    saveEvents(events);
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function makeDump() {
    return {
      generated_at: new Date().toISOString(),
      href: location.href,
      userAgent: navigator.userAgent,
      memory: getMemory(),
      events: loadEvents(),
    };
  }

  function renderCollector() {
    const dump = makeDump();

    document.documentElement.innerHTML = `
      <body style="font-family: system-ui, sans-serif; padding: 24px; line-height: 1.4;">
        <h1>ChatGPT perf dump</h1>
        <p>This collector reads the local flight-recorder log without booting the full ChatGPT app.</p>
        <p>
          <button id="download">Download dump</button>
          <button id="copy">Copy dump</button>
          <button id="clear">Clear saved events</button>
        </p>
        <pre id="out" style="white-space: pre-wrap; font-size: 12px; border: 1px solid #999; padding: 12px; max-height: 70vh; overflow: auto;"></pre>
      </body>
    `;

    const text = JSON.stringify(dump, null, 2);
    document.getElementById("out").textContent = text;

    document.getElementById("download").onclick = () => {
      downloadJSON(`chatgpt-perf-${Date.now()}.json`, dump);
    };

    document.getElementById("copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    };

    document.getElementById("clear").onclick = () => {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    };

    window.stop?.();
  }

  if (location.pathname === "/perf-dump") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderCollector, { once: true });
    } else {
      renderCollector();
    }
    return;
  }

  add("installed", {
    href: location.href,
    userAgent: navigator.userAgent,
    memory: getMemory(),
  });

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        add("longtask", {
          duration_ms: Math.round(entry.duration),
          name: entry.name,
          attribution: entry.attribution?.map?.((a) => ({
            name: a.name,
            entryType: a.entryType,
            containerType: a.containerType,
            containerName: a.containerName,
            containerSrc: a.containerSrc,
          })),
        });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    add("longtaskUnsupported", { error: String(error) });
  }

  let last = performance.now();

  setInterval(() => {
    const current = performance.now();
    const lag = current - last - 1000;
    last = current;

    if (lag > 250) {
      add("eventLoopLag", { lag_ms: Math.round(lag) });
    }

    if (lag > 1000) {
      add("lagSnapshot", {
        lag_ms: Math.round(lag),
        memory: getMemory(),
        dom: {
          nodes: document.getElementsByTagName("*").length,
          selectors: selectorCounts(),
        },
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      });
    }
  }, 1000);

  window.addEventListener("error", (event) => {
    add("error", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      col: event.colno,
      stack: event.error?.stack?.slice(0, 1000),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    add("unhandledrejection", {
      reason: String(event.reason),
      stack: event.reason?.stack?.slice?.(0, 1000),
    });
  });

  window.cgptPerfFlightRecorder = {
    dump: makeDump,
    clear() {
      localStorage.removeItem(STORAGE_KEY);
    },
  };
})();
