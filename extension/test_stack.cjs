// test_stack.cjs — valida a pilha de saídas (clipboard), "Limpar" e histórico.
const path = require("path");
const fs = require("fs");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)));

class El {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.attrs = attrs;
    this.style = { cssText: "" };
    this.parentNode = null;
    this._handlers = {};
    this._text = "";
    this.id = attrs.id || "";
    this.className = attrs.class || "";
    this.dataset = {};
    this.classList = { _s: new Set(String(this.className).split(/\s+/).filter(Boolean)),
      add(c){ this._s.add(c); }, contains(c){ return this._s.has(c); } };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { this.parentNode && this.parentNode.removeChild(this); }
  querySelectorAll(sel) {
    const out = [];
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const match = (n) => (cls ? n.classList.contains(cls) : n.tagName === sel.toUpperCase());
    (function walk(n) { for (const c of n.children) { if (match(c)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener() {} focus() {}
}

// document.querySelectorAll global (usado para achar a imagem etc.) — vazio.
const docEl = new El("html");
const document = new El("html");
document.documentElement = docEl;
document.head = new El("head");
document.body = new El("body");
document.getElementById = (id) => {
  let found = null;
  (function walk(n){ for (const c of n.children){ if (c.id === id) { found = c; return; } walk(c); if (found) return; } })(document.body);
  return found;
};
document.createElement = (t, a) => new El(t, a || {});
document.querySelector = () => null;
document.querySelectorAll = () => [];

global.document = document;
global.window = global;
global.addEventListener = () => {};
global.setInterval = () => 0;
global.setTimeout = (fn) => (fn && false);
global.MutationObserver = class { observe() {} disconnect() {} };
global.Event = class { constructor(type) { this.type = type; } };
global.KeyboardEvent = class { constructor(type, o) { this.type = type; this.key = o.key; this.bubbles = !!o.bubbles; } };

global.chrome = {
  runtime: { sendMessage: (m, cb) => cb && cb({ exit: 0, stdout: "", stderr: "", duration_ms: 1 }),
             getURL: (p) => "chrome-extension://test/" + p, onMessage: { addListener() {} } },
  storage: { local: { set() {}, get(k, cb) { cb && cb({}); } }, onChanged: { addListener() {} } },
};

global.module = { exports: {} };
global.__aispLoaded = false;
try {
  const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const fn = new Function("module", "window", "document", "chrome", "console", "MutationObserver", "Event", "KeyboardEvent", src);
  fn(global.module, global.window, global.document, global.chrome, console, global.MutationObserver, global.Event, global.KeyboardEvent);
} catch (e) { console.log("eval erro:", e.message); }
const exp = global.module.exports;

ok(typeof exp.pushOutput === "function" && typeof exp.clearOutput === "function", "exporta pushOutput/clearOutput");

const mkEntry = (cmd, out) => ({ cmd, exit: 0, duration_ms: 1, stdout: out, stderr: "" });

exp.pushOutput(mkEntry("echo a", "a\n"));
exp.pushOutput(mkEntry("pwd", "/tmp\n"));
ok(exp.getOutputLog().length === 2, "pushOutput anexa (2 saídas na pilha)");

const box = document.getElementById("aisp-result-box");
ok(box && box.textContent.includes("echo a") && box.textContent.includes("pwd"),
   "popup renderiza as duas saídas empilhadas");

const all = exp.resultToText(exp.getOutputLog());
ok(all.includes("echo a") && all.includes("pwd"), "resultToText(pilha) concatena saídas");

exp.clearOutput();
ok(exp.getOutputLog().length === 0, "clearOutput zera a pilha (clipboard)");
ok(exp.getHistory().length === 1 && exp.getHistory()[0].items.length === 2, "clearOutput arquiva lote no histórico");
const box2 = document.getElementById("aisp-result-box");
ok(box2 && !box2.textContent.includes("pwd"), "popup limpo após Limpar");

exp.pushOutput(mkEntry("ls", "x\n"));
ok(exp.getOutputLog().length === 1, "nova saída recomeça a pilha vazia");
exp.clearOutput();
ok(exp.getHistory().length === 2, "segundo lote arquivado");

console.log(`\nstack: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
