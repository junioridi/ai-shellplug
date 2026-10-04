// test_heredoc_autostart.cjs — reproduz o warning visto no popup ao rodar:
//   cat > ~/.config/autostart/conky.desktop <<'EOF'
//   [Desktop Entry]
//   ...
//   EOF
// Verifica: (1) o parser mantém o heredoc íntegro num único comando;
// (2) o servidor executa sem warning e o arquivo tem o conteúdo exato.
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

const OUT = "/tmp/conky.desktop.test." + process.pid; // único: evita órfão root:root em /tmp
const CMD = [
  "cat > " + OUT + " <<'EOF'",
  "[Desktop Entry]",
  "Type=Application",
  "Name=Conky System Monitor",
  "Comment=Estatísticas do sistema sobre o wallpaper",
  "Exec=/home/junior/.local/bin/conky-start.sh",
  "Terminal=false",
  "X-GNOME-Autostart-enabled=true",
  "Hidden=false",
  "NoDisplay=false",
  "EOF",
  "echo FEITO:$?",
  "cat " + OUT,
].join("\n");
try { fs.unlinkSync(OUT); } catch {}

let bad = 0; const ok = (b, m) => { console.log((b ? "PASS" : "FAIL") + " " + m); if (!b) bad++; };

(async () => {
  const cmds = X.extractCommands("```bash\n" + CMD + "\n```");
  ok(cmds.length === 1, "parser: 1 comando (got " + cmds.length + ")");
  ok(cmds[0] === CMD, "parser: heredoc íntegro (len " + cmds[0].length + " vs " + CMD.length + ")");
  if (cmds[0] !== CMD) {
    for (let i = 0; i < Math.max(cmds[0].length, CMD.length); i++) if (cmds[0][i] !== CMD[i]) {
      console.log("  difere char " + i + ": got " + JSON.stringify(cmds[0].slice(i, i + 40)) + " exp " + JSON.stringify(CMD.slice(i, i + 40))); break;
    }
  }

  const TOK = fs.readFileSync("/tmp/aisp_tok", "utf8").trim();
  const r = await fetch("http://127.0.0.1:8765/run", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": TOK },
    body: JSON.stringify({ sid: "heredoc", cmd: cmds[0] }) });
  const j = await r.json();
  console.log("--- exit:", j.exit, "| stderr:", JSON.stringify((j.stderr || "").trim()));
  ok((j.stderr || "").trim() === "", "sem warning/stderr no servidor");
  ok(/FEITO:0/.test(j.stdout || ""), "heredoc executou (FEITO:0)");
  ok(/Name=Conky System Monitor/.test(j.stdout || ""), "conteúdo do desktop presente no stdout");
  process.exit(bad ? 1 : 0);
})();
