// test_conky.cjs — Prova que um script multilinha real (Conky) atravessa o
// pipeline como UM ÚNICO comando íntegro: heredocs aninhados, set -e, pipes,
// substituições ${...} do conky, e linhas em branco. O parser NÃO deve dividir.
const fs = require("fs"), path = require("path");

// ---- Carrega content.js com um DOM mínimo ----
const sb = { module: { exports: {} }, window: {}, document: { addEventListener() {} }, chrome: {}, console };
sb.window.addEventListener = () => {}; sb.window.getSelection = () => null;
sb.document.createElement = () => ({ style: {}, appendChild() {}, remove() {} });
sb.document.getElementById = () => null; sb.document.documentElement = { appendChild() {} }; sb.document.body = null;
sb.MutationObserver = class { observe() {} };
sb.chrome.runtime = { getURL: u => u, sendMessage() {}, onMessage: { addListener() {} } };
sb.chrome.storage = { local: { get() {} }, onChanged: { addListener() {} } };
const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const fn = new Function("module","window","document","chrome","console","MutationObserver", src + "\nreturn module.exports;");
const X = fn(sb.module, sb.window, sb.document, sb.chrome, sb.console, sb.MutationObserver);

// Script Conky (trecho representativo com os casos difíceis).
const conky = `#!/bin/bash
set -e

echo "=== 1/6 — Instalando Conky e dependências ==="
sudo apt-get update -qq
sudo apt-get install -y -qq conky-all lm-sensors

mkdir -p "$HOME/.config/conky"

cat > "$HOME/.config/conky/conky-top-left.conf" <<'CONKY_TL'
conky.config = {
    alignment = 'top_left',
    gap_x = 20,
}
conky.text = [[
\${color0}╭─ CPU ─────────────────╮
\${color0}│\${color} CPU  \${cpu cpu0}% \${cpubar cpu0 6,120}
]]
CONKY_TL

cat > "$HOME/.local/bin/conky-start.sh" <<'START'
#!/bin/bash
conky -c "$HOME/.config/conky/conky-top-left.conf" &
wait
START
chmod +x "$HOME/.local/bin/conky-start.sh"

echo "✅ Instalação concluída!"`;

let bad = 0;
const ok = (b, m) => { console.log((b ? "PASS" : "FAIL") + " " + m); if (!b) bad++; };

// 1) O parser deve extrair UM ÚNICO comando (o script inteiro).
const cmds = X.extractCommands("```bash\n" + conky + "\n```");
ok(cmds.length === 1, "script Conky extraído como 1 comando (got " + cmds.length + ")");
const got = cmds[0] || "";

// 2) Caracteres/estruturas críticas preservados.
ok(got.includes("set -e"), "linha 'set -e' preservada");
ok(got.includes("cat > \"$HOME/.config/conky/conky-top-left.conf\" <<'CONKY_TL'"), "heredoc TL intacto");
ok(got.includes("cat > \"$HOME/.local/bin/conky-start.sh\" <<'START'"), "heredoc START intacto");
ok(got.includes("CONKY_TL"), "terminador CONKY_TL presente");
ok(got.includes("START"), "terminador START presente");
ok(got.includes("${color0}╭─ CPU ─────────────────╮"), "linha com ${...} do conky preservada");
ok(got.includes("conky -c \"$HOME/.config/conky/conky-top-left.conf\" &"), "comando com & preservado");
ok(got.includes("chmod +x \"$HOME/.local/bin/conky-start.sh\""), "linha após heredoc preservada");
ok((got.match(/\n/g) || []).length === (conky.match(/\n/g) || []).length, "mesmo número de linhas do original");

// 3) Não pode ter virar vários pedaços.
ok(!got.includes("__DIVIDED__"), "sem sentinela de divisão");

console.log(bad ? `\nconky: ${bad} falha(s)` : "\nconky: OK — script multilinha íntegro em um único comando");
process.exit(bad ? 1 : 0);
