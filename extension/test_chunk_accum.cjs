// test_chunk_accum.cjs — regressao: chunks SSE fragmentados NAO podem truncar
// o comando. Cada chunk traz um envelope JSON cujo campo string e um PEDACO do
// texto do modelo; o listener precisa extrair os deltas e CONCATENAR para
// reconstruir o bloco de codigo antes de extrair o comando.
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");

let failed = 0;
const check = (name, ok, extra) => {
  if (ok) console.log("PASS " + name);
  else { failed++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); }
};

function makeEl() {
  return {
    _children: [], style: { cssText: "" }, classList: { add() {}, remove() {}, contains() { return false; } },
    dataset: {}, _text: "", appendChild(c) { this._children.push(c); return c; },
    removeChild(c) { this._children = this._children.filter((x) => x !== c); },
    remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, contains() { return false; }, cloneNode() { return makeEl(); },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerText() { return this._text; }, set innerHTML(v) { this._text = String(v); },
  };
}

function loadContent() {
  const listeners = { message: [], storage: [] };
  const timers = [];
  const sent = [];
  const doc = {
    body: makeEl(), documentElement: makeEl(), readyState: "complete",
    createElement: () => makeEl(), getElementById: () => null,
    querySelector: () => null, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  };
  const win = {
    postMessage() {}, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    location: { href: "https://chat.deepseek.com/" }, document: doc,
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    document: doc, window: win, navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearTimeout: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      storage: {
        local: { get: (d, cb) => Promise.resolve(d || {}).then((v) => { if (cb) cb(v); return v; }), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: { addListener: (f) => listeners.storage.push(f) },
      },
      runtime: {
        sendMessage: (m, cb) => { if (m && m.type === "exec") sent.push(m); if (cb) cb({ ok: true, exit: 0, stdout: "", stderr: "", cwd: "/tmp" }); },
        onMessage: { addListener() {} }, getURL: (u) => u, lastError: null,
      },
    },
    Date, Math, JSON, String, Number, Object, Array, Promise, RegExp, Map, Set, Error,
    encodeURIComponent, decodeURIComponent, atob, btoa,
    module: { exports: {} },
  };
  sandbox.window.__aispSid = "p_test";
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "content.js" });

  return {
    exported: sandbox.module.exports,
    sent,
    cmds: () => sent.map((m) => m.cmd),
    fireMessage(data) { listeners.message.forEach((f) => f({ data })); },
    flushSettle() { const pend = timers.slice(); timers.length = 0; pend.forEach((tm) => tm.fn()); },
    pendingTimers: () => timers.length,
  };
}

const TAG = "__aisp__";
// Comando LONGO: o stream fragmenta o markdown em varios chunks.
const CMD = "cat " + "/tmp/very/long/path/" + "segment".repeat(30) + "/report_final.txt";
const fullText = "```json\n" + JSON.stringify({ tool: "exec", cmd: CMD }) + "\n```";
// chunks de ~100 chars do TEXTO do modelo, cada um num envelope SSE `data: {json}`.
const parts = [];
for (let i = 0; i < fullText.length; i += 100) parts.push(fullText.slice(i, i + 100));
// envelope realista: {"v":"<pedaco>","p":"append"}
const sse = (piece) => "data: " + JSON.stringify({ v: piece, p: "append" }) + "\n\n";

check("comando longo (>1 chunk)", CMD.length > 100 && parts.length > 2, "len=" + CMD.length + " parts=" + parts.length);

// 1) fragmentado: so executa apos o settle, com o comando COMPLETO reconstruido.
{
  const ctx = loadContent();
  for (const p of parts) ctx.fireMessage({ tag: TAG, kind: "ws", text: sse(p) });
  check("bufferiza sem executar de imediato", ctx.pendingTimers() > 0 && ctx.cmds().length === 0, "sent=" + JSON.stringify(ctx.cmds()));
  ctx.flushSettle();
  check("comando COMPLETO apos settle", ctx.cmds().includes(CMD), JSON.stringify(ctx.cmds()));
}

// 2) repro do bug antigo: so o ULTIMO chunk => comando truncado/ausente.
{
  const ctx = loadContent();
  ctx.fireMessage({ tag: TAG, kind: "ws", text: sse(parts[parts.length - 1]) });
  ctx.flushSettle();
  check("repro: 1 chunk sozinho = comando truncado/ausente", !ctx.cmds().includes(CMD), JSON.stringify(ctx.cmds()));
}

// 3) sseDeltas desempacota o campo string e ignora ruido (role/id/model).
{
  const ctx = loadContent();
  const s = ctx.exported.stripSseNoise('data: {"id":"abc","role":"assistant","v":"cat /tmp/x"}\n\n');
  check("desempacota o delta de texto", s === "cat /tmp/x", JSON.stringify(s));
}

// 4) buffer com teto nao perde o comando final.
{
  const ctx = loadContent();
  const filler = sse("x".repeat(500));
  for (let i = 0; i < 5000; i++) ctx.fireMessage({ tag: TAG, kind: "chunk", text: filler });
  for (const p of parts) ctx.fireMessage({ tag: TAG, kind: "chunk", text: sse(p) });
  ctx.flushSettle();
  check("comando sobrevive ao rolling buffer", ctx.cmds().includes(CMD), JSON.stringify(ctx.cmds()));
}

console.log(failed ? "\nCHUNK-ACCUM: FALHOU" : "\nCHUNK-ACCUM OK");
process.exit(failed ? 1 : 0);
