// test_gatilho.js — valida que linhas "!cmd" enviadas pelo usuário viram execução.
const fs = require("fs");
const path = require("path");
const dir = __dirname;

const listeners = [];
let ran = [];
const nodes = new Map();
function el(tag) {
  return {
    tagName: tag, id: "", style: {}, children: [], innerHTML: "", onclick: null,
    isContentEditable: false, value: undefined, innerText: "",
    getAttribute() { return null; },
    appendChild(c) { this.children.push(c); if (c.id) nodes.set(c.id, c); c.parent = this; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); },
    querySelector(sel) { return nodes.get(sel.replace("#", "")) || null; },
    addEventListener() {},
  };
}
const document = {
  body: el("body"),
  documentElement: el("html"),
  createElement: el,
  getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: () => [],
  addEventListener: (t, fn, cap) => { if (t === "keydown") listeners.push(fn); },
};
const window = { addEventListener() {}, getSelection: () => null, __aispLoaded: false };
const sent = [];
const chrome = {
  runtime: {
    getURL: (u) => u,
    sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb({ exit: 0, stdout: "ok\n", duration_ms: 1 }); },
    onMessage: { addListener() {} },
  },
  storage: { local: { get: () => {}, set() {} }, onChanged: { addListener() {} } },
};

const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");
const fn = new Function("module", "window", "document", "chrome", "console", "MutationObserver",
  src + "\nreturn module.exports;");
const { commandsFromUserText } = fn({ exports: {} }, window, document, chrome, console, class { observe() {} });

let pass = 0, fail = 0;
const ok = (c, m) => (console.log((c ? "PASS " : "FAIL ") + m), c ? pass++ : fail++);

// parser de linhas "!cmd"
ok(JSON.stringify(commandsFromUserText("!ls -la")) === '["ls -la"]', "captura '!ls -la'");
ok(JSON.stringify(commandsFromUserText("!!pwd")) === '["pwd"]', "captura '!!pwd'");
ok(JSON.stringify(commandsFromUserText("texto\n!echo oi\nmais")) === '["echo oi"]', "captura linha no meio");
ok(commandsFromUserText("resposta normal sem bang").length === 0, "ignora texto sem '!'");
ok(commandsFromUserText("fatorial 5!=120 não é comando").length === 0, "'!=' não dispara");

// simula Enter num composer (textarea com "!echo oi")
const textarea = el("TEXTAREA");
textarea.value = "!echo oi";
for (const h of listeners) h({ key: "Enter", shiftKey: false, target: textarea });
ok(sent.some((m) => m.type === "exec" && m.cmd === "echo oi"), "Enter com '!echo oi' chama exec");
ok(!sent.some((m) => m.cmd === "fatorial 5"), "não dispara falso-positivo");

// Enter em elemento que NÃO é composer não dispara
sent.length = 0;
for (const h of listeners) h({ key: "Enter", shiftKey: false, target: el("div") });
ok(sent.length === 0, "Enter fora do composer ignora");

// Shift+Enter (nova linha) não dispara
sent.length = 0;
textarea.value = "!whoami";
for (const h of listeners) h({ key: "Enter", shiftKey: true, target: textarea });
ok(sent.length === 0, "Shift+Enter (nova linha) não dispara");

console.log(`\ngatilho: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
