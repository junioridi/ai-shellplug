// test_e2e.js — Simula o fluxo content.js <-> background.js sem browser.
// Objetivo: provar que, ao detectar um comando no DOM, o banner de aprovação
// aparece e, após "Executar", o /run é chamado e o resultado é injetado.
const fs = require("fs");
const path = require("path");
const dir = __dirname;

// ---- storage local fake com onChanged ----
const store = {};
const listeners = [];
const storage = {
  local: {
    async get(defs) {
      const out = { ...defs };
      for (const k of Object.keys(defs)) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const k of Object.keys(obj)) {
        if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) {
          changes[k] = { oldValue: store[k], newValue: obj[k] };
          store[k] = obj[k];
        }
      }
      if (Object.keys(changes).length) listeners.forEach((f) => f(changes, "local"));
    },
  },
  onChanged: { addListener: (f) => listeners.push(f) },
};

// ---- runtime fake: conecta content <-> background ----
let bgHandler = null;
const runtime = {
  getURL: (u) => u,
  sendMessage(msg, cb) {
    // content -> background
    if (bgHandler) bgHandler(msg, {}, (res) => cb && cb(res));
    return true;
  },
  onMessage: { addListener: (f) => (bgHandler = f) },
};

// ---- DOM fake mínimo ----
const domNodes = {};
function mkEl(tag) {
  const el = {
    tag, textContent: "", innerHTML: "",
    style: { cssText: "" }, children: [], scrollTop: 0, scrollHeight: 0,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    title: "", dataset: {}, className: "", onclick: null,
    classList: { _s: new Set(), add(c){this._s.add(c);}, contains(c){return this._s.has(c);} },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const match = (n) => sel.startsWith(".")
        ? (n.classList && n.classList.contains(sel.slice(1)))
        : n.tag === sel;
      (function walk(n) { for (const c of n.children || []) { if (match(c)) out.push(c); walk(c); } })(this);
      return out;
    },
    remove() {},
  };
  el.id = "";
  return new Proxy(el, {
    set(o, k, v) {
      o[k] = v;
      if (k === "innerHTML") o.children = []; // simula limpeza real do DOM
      return true;
    },
  });
}
const document = {
  documentElement: mkEl("html"),
  head: mkEl("head"),
  body: { innerText: "", appendChild(n) { if (n.id) domNodes[n.id] = n; }, cloneNode() { return { innerText: this.innerText, querySelector: () => null }; } },
  createElement: mkEl,
  querySelectorAll: () => [],
    getElementById: (id) => domNodes[id] || null,
  addEventListener: () => {},
};
let moCb = null;
let codeCb = null;
class MutationObserver { constructor(cb) { this.cb = cb; } observe(t) { if (t === document.documentElement) moCb = this.cb; else codeCb = this.cb; } }
const window = { addEventListener: () => {}, __postMessage: () => {} };
window.postMessage = window.__postMessage;

// ---- fetch fake (servidor local) ----
let lastRun = null;
global.fetch = async (url, opts) => {
  lastRun = { url, opts, body: JSON.parse(opts.body) };
  return {
    ok: true, status: 200,
    async json() { return { exit: 0, timed_out: false, duration_ms: 3, stdout: "teste-ok\n", stderr: "" }; },
  };
};

function load(file) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const fn = new Function(
    "module", "exports", "chrome", "fetch", "console", "window", "document",
    "MutationObserver", "setTimeout", "Date",
    src + "\nreturn module.exports;"
  );
  return fn(
    { exports: {} }, {}, { runtime, storage },
    global.fetch, console, window, document, MutationObserver,
    setTimeout, Date
  );
}

// Carrega background primeiro (registra bgHandler), depois content.
load("background.js");
load("content.js");

(async () => {
  const ok = (b, m) => console.log((b ? "PASS" : "FAIL"), m);

  // 1) Simula resposta do DeepSeek renderizada no DOM (caminho confiável).
  const reply = 'claro!\n```json\n{"tool":"exec","cmd":"echo teste-ok"}\n```\n';
  document.body.innerText = reply;
  document.getElementById = (id) => domNodes[id] || null; // body guarda por id
  // dispara o MutationObserver
  moCb([{ target: document.body }]);

  // dá tempo do async (sendMessage exec -> requestApproval -> storage.set)
  await new Promise((r) => setTimeout(r, 50));

  // 2) O banner deve ter sido criado com buttons
  const bar = domNodes["aisp-approval-bar"];
  ok(!!bar, "banner de aprovação existe");
  console.log("   DEBUG bar.children =", bar && bar.children.length, "innerHTML=", bar && JSON.stringify(bar.innerHTML));
  ok(bar && bar.children.length === 4, "banner tem 4 filhos (label + 3 botões)");
  // Conta botões de fato: os 3 últimos são botões com onclick.
  const btns = bar ? bar.children.filter((c) => typeof c.onclick === "function") : [];
  ok(btns.length === 3, "banner tem 3 botões (Executar/Tudo/Ignorar)");

  // 3) Simula clique em "Executar" (primeiro botão)
  if (bar) bar.children.filter((c) => typeof c.onclick === "function")[0].onclick();
  await new Promise((r) => setTimeout(r, 50));

  // 4) O /run foi chamado com o cmd correto?
  ok(!!lastRun, "POST /run foi chamado após aprovar");
  ok(lastRun && lastRun.body.cmd === "echo teste-ok", "cmd correto enviado");
  ok(lastRun && /\/run$/.test(lastRun.url), "URL termina em /run");

  // 5) Resultado injetado na página?
  const box = domNodes["aisp-result-box"];
  ok(!!box, "caixa de resultado injetada");
  ok(box && /teste-ok/.test(box.textContent), "stdout aparece na caixa");

  // 6) Log foi para o storage (visível no popup)?
  ok(Array.isArray(store.aispLog) && store.aispLog.length > 0, "log populado no storage");
  if (store.aispLog) console.log("   log:", store.aispLog.map((e) => `${e.level}:${e.msg}`).join(" | ").slice(0, 300));

  // 7) Dedup: mesmo comando não roda 2x
  const before = lastRun;
  moCb([{ target: document.body }]);
  await new Promise((r) => setTimeout(r, 30));
  ok(lastRun === before, "comando duplicado é ignorado");
})();
