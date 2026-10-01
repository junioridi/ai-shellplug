// test_hotkey.js — Simula o atalho Ctrl+Q e valida abrir/fechar a janela overlay.
const fs = require("fs");
const path = require("path");
const dir = __dirname;

// --- DOM mínimo -------------------------------------------------------------
const listeners = { keydown: [] };
const nodes = new Map();
function makeEl(tag) {
  const el = {
    tagName: tag, id: "", style: { cssText: "" }, children: [], textContent: "", onclick: null,
    appendChild(c) { this.children.push(c); if (c.id) nodes.set(c.id, c); c.parent = this; return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); if (this.id) nodes.delete(this.id); },
    querySelector(sel) { const id = sel.replace("#", ""); return nodes.get(id) || null; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  // Emula a criação dos elementos com id presentes no innerHTML atribuído.
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html || ""; },
    set(html) {
      el._html = html;
      for (const m of html.matchAll(/id=['"]([^'"]+)['"]/g)) {
        const child = makeEl("div");
        child.id = m[1];
        child.parent = el;
        el.children.push(child);
        nodes.set(m[1], child);
      }
    },
  });
  return el;
}
const body = makeEl("body");
const document = {
  body,
  createElement: (t) => makeEl(t),
  getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: () => [],
  documentElement: makeEl("html"),
  head: makeEl("head"),
  addEventListener: () => {},
};
const window = {
  addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
  removeEventListener: () => {},
  getSelection: () => null,
  __aispLoaded: false,
};
const chrome = {
  runtime: { getURL: (u) => u, sendMessage: () => {}, onMessage: { addListener() {} } },
  storage: { local: { get: (d, cb) => (cb ? cb(d) : Promise.resolve(d)) }, onChanged: { addListener() {} } },
};

const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");
const fn = new Function("window", "document", "chrome", "console", "MutationObserver", src);
fn(window, document, chrome, console, class { observe() {} });

// --- Testes -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (c, m) => (console.log((c ? "PASS " : "FAIL ") + m), c ? pass++ : fail++);

// dispara keydown capturado pelo content script (listener em window, capture=true)
const keydown = (init) => {
  let prevented = false;
  for (const h of listeners.keydown || []) {
    h({ ctrlKey: false, shiftKey: false, altKey: false, repeat: false, key: "q", preventDefault: () => { prevented = true; }, ...init });
  }
  return prevented;
};

ok(!document.getElementById("aisp-quick-window"), "janela não existe antes do atalho");
keydown({ ctrlKey: true });
ok(!!document.getElementById("aisp-quick-window"), "Ctrl+Q abre a janela");
keydown({ ctrlKey: true });
ok(!document.getElementById("aisp-quick-window"), "Ctrl+Q fecha a janela");
keydown({ ctrlKey: true });
ok(!!document.getElementById("aisp-quick-window"), "Ctrl+Q reabre a janela");
const closeBtn = document.getElementById("aisp-quick-window").querySelector("#aisp-qw-close");
closeBtn.onclick();
ok(!document.getElementById("aisp-quick-window"), "botão ✕ fecha a janela");
keydown({ key: "q" }); // sem ctrl
ok(!document.getElementById("aisp-quick-window"), "tecla 'q' sem Ctrl não abre");
keydown({ ctrlKey: true, key: "x" });
ok(!document.getElementById("aisp-quick-window"), "Ctrl+X não abre");

console.log(`\nhotkey: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
