// test_pastelast.cjs — valida o botão "Colar último resultado".
// Fluxo: botão Executar (auto, sem popup) -> guarda lastResult ->
// botão "Colar último resultado" insere "This is the result of the last command: \n<res>"
// no composer e dispara nova interação (envio).
const path = require("path");
const fs = require("fs");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)));

// ---- DOM mínimo ----
class El {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.attrs = attrs;
    this.style = { cssText: "" };
    this.parentNode = null;
    this._events = [];
    this._handlers = {};
    this.value = "";
    this.innerText = "";
    this.id = attrs.id || "";
    this.type = attrs.type || "";
    this.isContentEditable = this.tagName === "DIV" && attrs.contenteditable === "true";
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; this.children.unshift(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  querySelector(sel) {
    const match = (n) => {
      if (sel.startsWith("#")) return n.id === sel.slice(1);
      if (sel === "textarea") return n.tagName === "TEXTAREA";
      if (sel.includes("textarea[placeholder]")) return n.tagName === "TEXTAREA";
      return false;
    };
    for (const c of this.children) if (match(c)) return c;
    return null;
  }
  closest() { return null; }
  addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); }
  dispatchEvent(ev) { this._events.push(ev.type); (this._handlers[ev.type] || []).forEach((f) => f(ev)); return true; }
  focus() {}
  click() { this.onclick && this.onclick({ preventDefault() {}, stopPropagation() {} }); }
}

// ---- Ambiente global ----
const sendMessage = (msg, cb) => {
  if (msg && msg.type === "exec") global.__sent = msg;
  cb({ exit: 0, stdout: "teste-ok\n", stderr: "", duration_ms: 12, timed_out: false });};

const composer = new El("textarea", { placeholder: "Message DeepSeek" });
const form = new El("form");
form.appendChild(composer);

global.chrome = {
  runtime: {
    sendMessage,
    getURL: (p) => "chrome-extension://test/" + p,
  },
  storage: {
    local: { set() {}, get() {} },
    onChanged: { addListener() {} },
  },
};
global.window = global;
global.addEventListener = () => {};
global.setInterval = () => 0;
global.setTimeout = (fn) => (fn && false);
global.document = new El("html");
global.MutationObserver = class { observe() {} disconnect() {} };
global.Event = class { constructor(type) { this.type = type; } };
global.KeyboardEvent = class { constructor(type, o) { this.type = type; this.key = o.key; this.bubbles = !!o.bubbles; } };
global.KeyEvent = global.KeyboardEvent;
// document.querySelector deve encontrar o composer e (depois) o botão
document.querySelector = (sel) => {
  if (sel.includes("textarea")) return composer;
  if (sel === "#aisp-paste-last") return document.querySelectorAll("#aisp-paste-last")[0] || null;
  return null;
};
const _all = [];
document.querySelectorAll = () => _all.filter((b) => b.id === "aisp-paste-last");

// intercepta criação de elementos para capturar o botão
const _create = (tag, attrs) => {
  const el = new El(tag, attrs || {});
  if (el.id === "aisp-paste-last" || (attrs && attrs.id === "aisp-paste-last")) _all.push(el);
  return el;
};
document.createElement = (tag, attrs) => {
  const el = _create(tag, attrs);
  return el;
};
document.body = new El("body");
document.head = new El("head");
document.documentElement = new El("html");
document.body.appendChild(form);

// ---- Carrega módulo ----
// Guarda o composer como pai para o botão ser inserido e capturável
let mod;
const contentPath = path.join(__dirname, "content.js");
const src = fs.readFileSync(contentPath, "utf8");
global.module = { exports: {} };
global.__aispLoaded = false;
try {
  const fn = new Function("module", "window", "document", "chrome", "console", "MutationObserver", "Event", "KeyboardEvent", src);
  fn(global.module, global.window, global.document, global.chrome, console, global.MutationObserver, global.Event, global.KeyboardEvent);
} catch (e) {
  console.log("eval erro:", e.message);
}
mod = global.module.exports;
console.log("chaves exportadas:", Object.keys(mod));
console.log("__aispLoaded:", global.__aispLoaded);

ok(typeof mod.pasteLastResult === "function", "exporta pasteLastResult");
ok(typeof mod.attachPasteLastButton === "function", "exporta attachPasteLastButton");

// ---- 1) Botão Executar roda sem popup (auto) e guarda resultado ----
// Simula o clique do módulo: injeta um comando via runCommand equivalente.
// Usamos o caminho real: o módulo guarda lastResult ao receber resposta.
// Disparo via exec auto:
global.__sent = null;
// chama pasteLastResult sem resultado -> deve falhar educadamente
const before = mod.pasteLastResult();
ok(before === false, "sem último resultado -> não envia (retorna false)");

// ---- 2) Pré-carrega um resultado, como se o botão Executar tivesse rodado ----
// attachPasteLastButton insere o botão; depois preenchemos lastResult via fluxo real
mod.attachPasteLastButton();
// o botão é inserido como filho do parent do composer (form)
const btn = form.children.find((c) => c.id === "aisp-paste-last");
ok(!!btn, "botão 'Colar último resultado' inserido");
ok(btn && /Colar último resultado/.test(btn.textContent), "rótulo do botão correto");

// ---- 3) Botão Executar (auto) -> guarda lastResult -> cola e envia ----
global.__sent = null;
const _r = mod.runCommand ? "ok" : "missing";
mod.runCommand("echo teste", true); // como o botão Executar faz
console.log("probe runCommand:", _r, "sent:", JSON.stringify(global.__sent), "last:", JSON.stringify(mod.getLastResult()));
ok(global.__sent && global.__sent.type === "exec", "runCommand envia exec");
ok(global.__sent && global.__sent.auto === true, "runCommand auto=true (sem popup)");
ok(mod.getLastResult() && mod.getLastResult().stdout === "teste-ok\n", "lastResult guardado com stdout");

// ---- 4) Colar último resultado preenche composer e dispara envio ----
const clicked = mod.pasteLastResult();
ok(clicked === true, "pasteLastResult retorna true com resultado disponível");
ok(composer.value.startsWith("This is the result of the last command: \n"),
   "composer recebeu o prefixo exigido");
ok(composer.value.includes("echo teste") && composer.value.includes("teste-ok"),
   "composer contém cmd e saída do último resultado");
ok(composer._events.includes("input"), "disparou evento input no composer");
ok(composer._events.includes("keydown") && composer._events.includes("keyup"),
   "disparou Enter (keydown/keyup) para enviar nova interação");

console.log("\npastelast: " + pass + "/" + (pass + fail));
process.exit(fail ? 1 : 0);
