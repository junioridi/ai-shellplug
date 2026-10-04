// test_pathreg.cjs — regressão: o parser NÃO pode truncar caminhos com extensão
// (ex.: "cat /tmp/c.txt" virando "cat /tmp"). Sintoma observado no log do
// servidor: cmd="cat /tmp" com exit=1 após "pgrep -a cursor > /tmp/c.txt".
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, "content.js"), "utf8");

const sb = { module: { exports: {} }, window: {}, document: { addEventListener() {} }, chrome: {}, console };
sb.window.addEventListener = () => {};
sb.window.getSelection = () => null;
sb.document.createElement = () => ({ style: {}, appendChild() {}, remove() {} });
sb.document.getElementById = () => null;
sb.document.documentElement = { appendChild() {} };
sb.document.body = null;
sb.MutationObserver = class { observe() {} };
sb.chrome.runtime = { getURL: (u) => u, sendMessage() {}, onMessage: { addListener() {} } };
sb.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };

const fn = new Function(
  "module", "window", "document", "chrome", "console", "MutationObserver",
  src + "\nreturn module.exports;"
);
const X = fn(sb.module, sb.window, sb.document, sb.chrome, sb.console, sb.MutationObserver);

let ok = 0, bad = 0;
const chk = (cond, msg) => { cond ? ok++ : bad++; console.log((cond ? "PASS" : "FAIL") + " " + msg); };
const g = (t) => X.extractCommands(t).join(" | ");

chk(g("```bash\ncat /tmp/c.txt\n```") === "cat /tmp/c.txt", "bloco bash preserva path completo");
chk(g("```bash\npgrep -a cursor > /tmp/c.txt\n```") === "pgrep -a cursor > /tmp/c.txt", "redirect com path completo");
chk(g("```sh\ncat /tmp/c.txt && ls\n```") === "cat /tmp/c.txt && ls", "&& preservado");
chk(g("```shell\ncd /tmp\ncat /tmp/c.txt\n```") === "cd /tmp\ncat /tmp/c.txt", "bloco multilinha = script único");
chk(g('```json\n{"tool":"exec","cmd":"cat /tmp/c.txt"}\n```') === "cat /tmp/c.txt", "json fenced");
chk(g('{"tool":"exec","cmd":"cat /tmp/c.txt"}') === "cat /tmp/c.txt", "json inline");
chk(g("A soma de 2+2 é 4. Basta usar a fórmula.") === "", "prosa sem comando => vazio");
chk(g("```bash\n$ cat /tmp/c.txt\n```") === "cat /tmp/c.txt", "prompt $ removido, path inteiro");

console.log(`\npathreg: ${ok}/${ok + bad}`);
process.exit(bad ? 1 : 0);
