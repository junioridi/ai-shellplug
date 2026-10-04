// test_smoke_boot.cjs — garante que content.js, background.js e inject.js
// carregam sem ReferenceError/TypeError em um DOM/chrome simulados.
// Cobre a regressao "ReferenceError: t is not defined" (variavel fora de escopo).
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
let failed = 0;

function el() {
  return {
    style: {}, classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, remove() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    cloneNode() { return el(); }, contains: () => false, dispatchEvent() {},
  };
}

function makeSandbox() {
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    document: {
      head: el(), documentElement: el(), body: el(), createElement: el,
      addEventListener() {}, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], execCommand() {},
    },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    chrome: {
      runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: () => "chrome-extension://x/f.js", lastError: null },
      storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
      tabs: {}, scripting: {},
    },
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
    navigator: { clipboard: { writeText() {} } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "https://chat.deepseek.com/" },
    XMLHttpRequest: class {}, WebSocket: class { constructor() {} addEventListener() {} },
    self: null, window: null,
  };
  sb.window = sb;
  sb.self = sb;
  return sb;
}

for (const f of ["content.js", "background.js", "inject.js"]) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const sb = makeSandbox();
  try {
    vm.createContext(sb);
    vm.runInContext(src, sb, { filename: f });
    console.log(`PASS ${f} carregou sem erro`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${f}: ${e.name} - ${e.message}`);
  }
}

// prova explicita: nenhum "ReferenceError: t" deve escapar
if (failed) { console.log("\nSMOKE: falhou"); process.exit(1); }
console.log("\nSMOKE OK — os 3 scripts carregam sem ReferenceError");
