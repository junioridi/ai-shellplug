// test_heredoc_dom.cjs — Verifica que codeFromBlock preserva quebras de linha
// quando o DeepSeek renderiza cada linha do bloco em elementos (<div>/<span>)
// separados, SEM <br>. Sem isso, o heredoc chega colado e o bash avisa:
//   "warning: here-document at line 1 delimited by end-of-file (wanted `EOF')"
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

let bad = 0; const ok = (b, m) => { console.log((b ? "PASS" : "FAIL") + " " + m); if (!b) bad++; };

// Mini-DOM: cria nós. linhas = array de strings; cada linha vira um <div>.
function tnode(t) { return { nodeType: 3, nodeValue: t, textContent: t, childNodes: [] }; }
function el(tag, kids) {
  const n = { tagName: tag, nodeType: 1, childNodes: kids || [], _children: kids || [] };
  n.textContent = (kids || []).map(k => k.textContent != null ? k.textContent : "").join("");
  n.querySelector = () => null;
  return n;
}
function codeBlock(lines, mkLine) {
  const lineEls = lines.map(l => mkLine(l));
  const code = el("CODE", lineEls);
  const pre = el("PRE", [code]);
  return { tagName: "DIV", querySelector: (sel) => /pre code|code/.test(sel) ? code : /pre/.test(sel) ? pre : null };
}

const LINES = [
  "cat > ~/.config/autostart/conky.desktop <<'EOF'",
  "[Desktop Entry]",
  "Type=Application",
  "Name=Conky System Monitor",
  "Exec=/home/junior/.local/bin/conky-start.sh",
  "Terminal=false",
  "EOF",
];

// Cenário 1: cada linha num <div> (comuns em highlighters por linha).
const blkDiv = codeBlock(LINES, (l) => el("DIV", [tnode(l)]));
const gotDiv = X.codeFromBlock(blkDiv);
ok(gotDiv === LINES.join("\n"), "div-por-linha: quebras preservadas\n--- got ---\n" + JSON.stringify(gotDiv));

// Cenário 2: cada linha num <span> dentro do <code>, sem nós de espaço.
const blkSpan = codeBlock(LINES, (l) => el("SPAN", [tnode(l)]));
const gotSpan = X.codeFromBlock(blkSpan);
ok(gotSpan === LINES.join("\n"), "span-por-linha: quebras preservadas\n--- got ---\n" + JSON.stringify(gotSpan));

// Cenário 3: uma linha com tokens internos + quebra entre elas (div contendo spans).
const blkMixed = codeBlock(LINES, (l) => el("DIV", l.split(/(\s+)/).filter(Boolean).map(t => el("SPAN", [tnode(t)]))));
const gotMixed = X.codeFromBlock(blkMixed);
ok(gotMixed === LINES.join("\n"), "div com spans de token: quebras + espaços\n--- got ---\n" + JSON.stringify(gotMixed));

console.log(bad ? `\nheredoc_dom: ${bad} falha(s)` : "\nheredoc_dom: OK");
process.exit(bad ? 1 : 0);
