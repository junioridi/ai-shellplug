// test_conky_start.cjs — Comando real que corrompeu ~/.local/bin/conky-start.sh:
//   cat > ~/.local/bin/conky-start.sh <<'EOF'
//   #!/bin/bash
//   ... (linhas com aspas "${VAR:-default}", $HOME, pkill -f "conky -c", &, wait)
//   EOF
//   chmod +x ~/.local/bin/conky-start.sh
// Verifica: (1) extractCommands devolve o heredoc + chmod íntegros;
// (2) splitBlockCommands não fatia em "&"/"wait" nem quebra o heredoc;
// (3) codeFromBlock preserva o texto quando o DOM vem em divs por linha.
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

const CMD = [
  "cat > ~/.local/bin/conky-start.sh <<'EOF'",
  "#!/bin/bash",
  "# Conky - 4 instâncias Wayland (COSMIC/Pop!_OS)",
  'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"',
  'export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"',
  "",
  'CONKY_DIR="$HOME/.config/conky"',
  'pkill -f "conky -c" 2>/dev/null',
  "sleep 1",
  "",
  'conky -c "$CONKY_DIR/conky-top-left.conf" &',
  'conky -c "$CONKY_DIR/conky-top-right.conf" &',
  'conky -c "$CONKY_DIR/conky-bottom-left.conf" &',
  'conky -c "$CONKY_DIR/conky-bottom-right.conf" &',
  "",
  "wait",
  "EOF",
  "chmod +x ~/.local/bin/conky-start.sh",
].join("\n");

// --- mini-DOM para codeFromBlock (linhas em <div> dentro de <code>) ---
function tnode(t) { return { nodeType: 3, nodeValue: t, textContent: t, childNodes: [] }; }
function el(tag, kids) {
  const n = { tagName: tag, nodeType: 1, childNodes: kids || [] };
  n.textContent = kids.map(k => k.textContent || "").join("");
  return n;
}

(async () => {
  // 1) extractCommands sobre o texto cru (fonte mais comum)
  const cmds = X.extractCommands("```bash\n" + CMD + "\n```");
  ok(cmds.length === 1, "extractCommands: 1 comando (got " + cmds.length + ")");
  ok(cmds[0] === CMD, "extractCommands: íntegro (len " + (cmds[0]||"").length + " vs " + CMD.length + ")");

  // 2) splitBlockCommands: NÃO pode fatiar em '&' nem em 'wait'
  const parts = X.splitBlockCommands(CMD);
  ok(parts.length === 2, "split: 2 comandos (heredoc + chmod), got " + parts.length + " -> " + JSON.stringify(parts.map(p => p.split("\n")[0])));
  ok(/cat > .* <<'EOF'/.test(parts[0]) && /chmod \+x/.test(parts[1]), "split: heredoc e chmod separados corretamente");
  ok(parts[0].includes("EOF") && parts[0].trim().endsWith("EOF"), "split: heredoc conserva o delimitador EOF");

  // 3) codeFromBlock com DOM div-por-linha
  const lineEls = CMD.split("\n").map(l => el("DIV", [tnode(l)]));
  const code = el("CODE", lineEls), pre = el("PRE", [code]);
  const blk = { tagName: "DIV", querySelector: (s) => /pre code|code/.test(s) ? code : /pre/.test(s) ? pre : null };
  const got = X.codeFromBlock(blk);
  ok(got === CMD, "codeFromBlock(div): íntegro\n--- got ---\n" + JSON.stringify(got));

  console.log(bad ? `\nconky_start: ${bad} falha(s)` : "\nconky_start: OK");
  process.exit(bad ? 1 : 0);
})();
