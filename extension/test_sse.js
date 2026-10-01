// test_sse.js — Simula a resposta REAL do DeepSeek: streaming SSE com o bloco
// JSON picado em vários chunks. Usa a MESMA extração do content.js.
const fs = require("fs");
const path = require("path");
const dir = __dirname;

const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");
const sandbox = { window: {}, document: { addEventListener() {} }, chrome: {}, console };
sandbox.window.addEventListener = () => {};
sandbox.window.getSelection = () => null;
sandbox.document.createElement = () => ({ style: {}, appendChild() {}, remove() {} });
sandbox.document.getElementById = () => null;
sandbox.document.documentElement = { appendChild() {} };
sandbox.document.body = null;
sandbox.chrome.runtime = { getURL: (u) => u, sendMessage() {}, onMessage: { addListener() {} } };
sandbox.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };
const fn = new Function("module", "window", "document", "chrome", "console", "MutationObserver", src + "\nreturn module.exports;");
const { extractCommands } = fn(
  { exports: {} }, sandbox.window, sandbox.document, sandbox.chrome, sandbox.console,
  class { observe() {} }
);

// Resposta SSE crua como o inject.js entrega (fetch .text()).
const SSE =
  'data: {"choices":[{"delta":{"content":"Claro, vou rodar:\\n\\n```json\\n"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"exec\\",\\"cmd\\":\\"echo teste-ok\\"}\\n"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"```\\nFim."}}]}\n\n' +
  "data: [DONE]\n\n";

const got = extractCommands(SSE);
console.log("SSE cru ->", JSON.stringify(got));
const ok = got.length === 1 && got[0] === "echo teste-ok";
console.log(ok ? "PASS sse" : "FAIL sse");
process.exit(ok ? 0 : 1);
