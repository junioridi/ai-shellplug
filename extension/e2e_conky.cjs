// e2e_conky.cjs — pipeline real: parser → servidor → shell.
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

const TOK = fs.readFileSync("/tmp/aisp_tok", "utf8").trim();

// Script real (mesmos padrões: set -e, heredocs aninhados, chmod após heredoc).
const conky = [
  "#!/bin/bash",
  "set -e",
  'echo "=== inicio ==="',
  'rm -rf "/tmp/aisp_conky" 2>/dev/null; mkdir -p "/tmp/aisp_conky"',
  'cat > "/tmp/aisp_conky/a.conf" <<\'TL\'',
  'linha com " aspas e ${var}',
  "segunda linha",
  "TL",
  'cat > "/tmp/aisp_conky/start.sh" <<\'START\'',
  "#!/bin/bash",
  'echo "rodando"',
  "START",
  'chmod +x "/tmp/aisp_conky/start.sh"',
  'echo "=== fim ==="',
].join("\n");

(async () => {
  let bad = 0;
  const ok = (b, m) => { console.log((b ? "PASS" : "FAIL") + " " + m); if (!b) bad++; };

  const cmds = X.extractCommands("```bash\n" + conky + "\n```");
  ok(cmds.length === 1, "parser: 1 comando (got " + cmds.length + ")");

  const r = await fetch("http://127.0.0.1:8765/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": TOK },
    body: JSON.stringify({ sid: "conky", cmd: cmds[0] }),
  });
  const j = await r.json();
  ok(j.exit === 0, "servidor: exit=0 (got " + j.exit + ") stderr=" + JSON.stringify((j.stderr||"").trim()));
  const out = (j.stdout || "");
  ok(out.includes("=== inicio ===") && out.includes("=== fim ==="), "echo antes e depois do heredoc preservados");
  ok(!/\$\(|\$\{/.test(out), "sem erro de substituicao (saida limpa)");

  // Verifica arquivos criados pelo heredoc.
  const chk = await fetch("http://127.0.0.1:8765/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": TOK },
    body: JSON.stringify({ sid: "conky", cmd: 'cat /tmp/aisp_conky/a.conf; echo "---"; test -x /tmp/aisp_conky/start.sh && echo EXECUTAVEL' }),
  });
  const jc = await chk.json();
  ok(jc.stdout.includes('linha com " aspas e ${var}') && jc.stdout.includes("segunda linha"), "heredoc gravou o conteudo literal");
  ok(jc.stdout.includes("EXECUTAVEL"), "chmod apos heredoc funcionou");

  console.log(bad ? `\nE2E: ${bad} falha(s)` : "\nE2E OK — script Conky executado de ponta a ponta");
  process.exit(bad ? 1 : 0);
})();
