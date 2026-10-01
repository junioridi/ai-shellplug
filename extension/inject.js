// ---------------------------------------------------------------------------
// inject.js — roda no MAIN world (contexto da página)
// Objetivo: hookar fetch/WebSocket para observar a conversa em tempo real.
// Repassa os chunks recebidos ao content script via window.postMessage, usando
// o protocolo {tag:"__aisp__", kind, text}. O parsing dos comandos é feito pelo
// content script.
// ---------------------------------------------------------------------------
(function () {
  "use strict";
  const TAG = "__aisp__";

  function emit(kind, text) {
    window.postMessage({ tag: TAG, kind, text }, "*");
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    const p = origFetch.apply(this, args);
    if (/deepseek\.com\/api\//.test(url)) {
      p.then((resp) => {
        try {
          const clone = resp.clone();
          clone.text().then((t) => {
            if (t && t.length < 200000) emit("fetch", t);
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
    }
    return p;
  };

  // ---- hook WebSocket ----
  const OrigWS = window.WebSocket;
  function PatchedWS(...args) {
    const url = args[0];
    const ws = new OrigWS(...args);
    if (/deepseek\.com/.test(String(url))) {
      ws.addEventListener("message", (ev) => {
        try {
          const data = typeof ev.data === "string" ? ev.data : "[binary]";
          if (data.length < 200000) emit("ws", data);
        } catch (_) {}
      });
    }
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = OrigWS.CONNECTING;
  PatchedWS.OPEN = OrigWS.OPEN;
  PatchedWS.CLOSING = OrigWS.CLOSING;
  PatchedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  console.log(TAG, "hooks instalados");
})();
