// test_gray_scroll.cjs — valida: (1) botão ▶ fica cinza ao executar;
// (2) scrollToLastRunButton rola até o último botão executado.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");

// --- DOM de mentira mínimo ---
let scrollCalls = [];
function mkEl(tag) {
  const el = {
    tagName: tag, style: { cssText: "", setProperty() {} }, dataset: {},
    children: [], parentNode: null, textContent: "", title: "", id: "", className: "",
    onclick: null, _listeners: {},
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    addEventListener(t, f) { (el._listeners[t] = el._listeners[t] || []).push(f); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView(opts) { scrollCalls.push(opts || true); },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20 }; },
    getAttribute() { return null; },
    setAttribute() {},
  };
  return el;
}
const blocks = [];
const document = {
  body: mkEl("body"),
  documentElement: mkEl("html"),
  createElement: (t) => mkEl(t),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: (sel) => (sel.includes(".md-code-block") ? blocks : []),
  addEventListener() {},
};
document.body.appendChild(document.documentElement);

const sb = {
  module: { exports: {} }, window: {}, document, chrome: {}, console,
};
sb.window.addEventListener = () => {};
sb.window.getSelection = () => null;
sb.MutationObserver = class { observe() {} };
sb.chrome.runtime = { getURL: (u) => u, sendMessage() {}, onMessage: { addListener() {} } };
sb.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };

const fn = new Function(
  "module", "window", "document", "chrome", "console", "MutationObserver",
  src + "\nreturn module.exports;"
);
const X = fn(sb.module, sb.window, sb.document, sb.chrome, sb.console, sb.MutationObserver);

let ok = 0, bad = 0;
const chk = (c, m) => { c ? ok++ : bad++; console.log((c ? "PASS" : "FAIL") + " " + m); };

// 1. grayOutRunButton deixa fundo/borda/texto cinza.
const btn = mkEl("button");
btn.style.cssText = "background:#2a2a2a;color:#7fffd4;border:1px solid #555";
X.grayOutRunButton(btn);
chk(btn.style.background === "#3a3a3a", "fundo vira cinza escuro (#3a3a3a)");
chk(btn.style.color === "#999", "texto vira cinza (#999)");
chk(btn.style.borderColor === "#555", "borda cinza");
chk(/já executado/.test(btn.title), "title marca 'comando já executado'");

// 2. grayOutRegister + scrollToLastRunButton chama scrollIntoView nesse botão.
scrollCalls = [];
X.scrollToLastRunButton();
chk(scrollCalls.length === 1, "scrollIntoView chamado uma vez no último botão");
chk(scrollCalls[0] && scrollCalls[0].behavior === "smooth" && scrollCalls[0].block === "center",
  "scroll suave e centralizado (behavior=smooth, block=center)");

// 3. grayOut numa entrada inválida não lança.
let threw = false;
try { X.grayOutRunButton(null); } catch (e) { threw = true; }
chk(!threw, "grayOutRunButton(null) não lança");

console.log(`\ngray_scroll: ${ok}/${ok + bad}`);
process.exit(bad ? 1 : 0);
