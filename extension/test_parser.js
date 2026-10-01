// test_parser.js — valida a extração REAL do content.js contra formatos
// que o DeepSeek realmente emite: bloco fenced, objeto inline e JSON escapado (SSE).
const fs = require("fs");
const path = require("path");
const dir = __dirname;

// 1) manifest válido
JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
console.log("manifest.json: VALIDO");

// 2) sintaxe dos JS
for (const f of ["content.js", "background.js", "inject.js", "popup.js"]) {
  new Function(fs.readFileSync(path.join(dir, f), "utf8"));
}
console.log("JS files: SINTAXE OK");

// 3) extrai a MESMA lógica do content.js (via module.exports) para não duplicar.
const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");
const sandbox = { module: { exports: {} }, window: {}, document: { addEventListener() {} }, chrome: {}, console };
// stub mínimo para o IIFE do content.js não quebrar ao ser avaliado.
sandbox.window.addEventListener = () => {};
sandbox.window.getSelection = () => null;
sandbox.document.createElement = () => ({ style: {}, appendChild() {}, remove() {} });
sandbox.document.getElementById = () => null;
sandbox.document.documentElement = { appendChild() {} };
sandbox.document.body = null;
sandbox.MutationObserver = class { observe() {} };
sandbox.chrome.runtime = { getURL: (u) => u, sendMessage() {}, onMessage: { addListener() {} } };
sandbox.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };

let extractCommands;
try {
  const fn = new Function("module", "window", "document", "chrome", "console", "MutationObserver", src + "\nreturn module.exports;");
  const exp = fn(sandbox.module, sandbox.window, sandbox.document, sandbox.chrome, sandbox.console, sandbox.MutationObserver);
  extractCommands = exp.extractCommands;
} catch (e) {
  console.log("nao consegui carregar content.js:", e.message);
  process.exit(1);
}
if (typeof extractCommands !== "function") {
  console.log("content.js nao exportou extractCommands");
  process.exit(1);
}

const c = "```";
const cases = [
  // fenced normal
  [c + 'json\n{"tool":"exec","cmd":"ls -la"}\n' + c, ["ls -la"]],
  // inline
  ['{"tool":"exec","cmd":"git status"}', ["git status"]],
  // sem comando
  ["ola mundo sem comando", []],
  // tool diferente é ignorada
  ['{"tool":"outra","cmd":"rm -rf /"}', []],
  // escape dentro de string
  ['texto antes {"tool":"exec","cmd":"echo \\"oi\\""} depois', ['echo "oi"']],
  // sem cmd
  ['{"tool":"exec"}', []],
  // cmd antes de tool
  ['{"cmd":"x","tool":"exec"}', ["x"]],
  // ---- formato DeepSeek SSE: JSON com aspas escapadas (\" ) ----
  ['data: {"v":"```json\\n{\\"tool\\":\\"exec\\",\\"cmd\\":\\"whoami\\"}\\n```"}', ["whoami"]],
  // comandos com pipe/redirect
  ['{"tool":"shell","cmd":"cat /etc/hosts | grep local"}', ["cat /etc/hosts | grep local"]],
  // dedup: mesmo cmd duas vezes
  ['{"tool":"exec","cmd":"pwd"} {"tool":"exec","cmd":"pwd"}', ["pwd"]],
  // múltiplos comandos distintos
  ['{"tool":"exec","cmd":"a"}\n{"tool":"exec","cmd":"b"}', ["a", "b"]],
  // ---- respostas NATURAIS do DeepSeek (sem JSON): bloco ```bash ----
  ["Claro! Rode:\n\n```bash\n$ ls -la\n$ whoami\n```\n", ["ls -la", "whoami"]],
  ["```sh\n# lista\npwd\n```", ["pwd"]],
  ["explica e Bloco:\n```shell\ndf -h\n```", ["df -h"]],
  // texto puramente natural sem bloco de shell: nada a executar
  ["A soma de 2+2 é 4. Basta usar a fórmula.", []],
];

let ok = 0;
for (const [inp, exp] of cases) {
  const got = extractCommands(inp);
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  if (pass) ok++;
  console.log((pass ? "PASS" : "FAIL"), JSON.stringify(inp).slice(0, 55), "->", JSON.stringify(got));
}
console.log(`parser: ${ok}/${cases.length}`);
process.exit(ok === cases.length ? 0 : 1);
