// test_quote.cjs — aspas, backslashes literais e heredoc no parser.
const fs = require("fs"), path = require("path");
const sb = { module: { exports: {} }, window: {}, document: { addEventListener() {} }, chrome: {}, console };
sb.window.addEventListener = () => {}; sb.window.getSelection = () => null;
sb.document.createElement = () => ({ style: {}, appendChild() {}, remove() {} });
sb.document.getElementById = () => null; sb.document.documentElement = { appendChild() {} }; sb.document.body = null;
sb.MutationObserver = class { observe() {} };
sb.chrome.runtime = { getURL: u => u, sendMessage() {}, onMessage: { addListener() {} } };
sb.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };
const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const X = new Function("module","window","document","chrome","console","MutationObserver", src + "\nreturn module.exports;")(
  sb.module, sb.window, sb.document, sb.chrome, sb.console, sb.MutationObserver);

let bad = 0;
const chk = (b, m) => { console.log((b ? "PASS" : "FAIL") + " " + m); if (!b) bad++; };
const g = (t) => X.extractCommands(t).join(" | ");

chk(g('```bash\necho "===\n```') === 'echo "===', "aspas não fechadas preservadas no fim");
chk(g('```sh\nprintf "%s\\n" "a\n```') === 'printf "%s\\n" "a', "aspas abertas em printf preservadas (\\n literal mantido)");
chk(g('```sh\ntr "\\0" "\\n" < /proc/x/environ\n```') === 'tr "\\0" "\\n" < /proc/x/environ', "tr com \\0 \\n literais não é desescapado");
chk(g('```bash\ncat <<EOF\ntexto com " aspas\nEOF\n```') === 'cat <<EOF\ntexto com " aspas\nEOF', "heredoc preservado como script único");
chk(g('```bash\necho "a b c"\n```') === 'echo "a b c"', "aspas fechadas normais");
chk(g('{"tool":"exec","cmd":"echo \\"==="}') === 'echo "===', "json com aspas abertas");

console.log(bad ? `quote: ${bad} falha(s)` : "quote: OK");
process.exit(bad ? 1 : 0);
