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

const BIG = [
 'echo "=== 1. SESSÃO ==="; pgrep cosmic-comp; loginctl list-sessions; ls /run/user/1000/; echo',
 'echo "=== 2. AMBIENTE ==="; env | grep -E "WAYLAND|XDG_RUNTIME|DISPLAY|^USER="; echo',
 'echo "=== 3. CONKY RODANDO? ==="; pgrep -a conky; echo',
 'echo "=== 4. ARQUIVOS ==="; ls -la ~/.config/conky/; ls -la ~/.local/bin/conky-start.sh; ls -la ~/.config/systemd/user/conky.service; ls -la ~/.config/autostart/; echo',
 'echo "=== 5. SCRIPT DE START ==="; cat ~/.local/bin/conky-start.sh; echo',
 'echo "=== 6. CONFIG TL ==="; grep -E "out_to_wayland|own_window_type|alignment|out_to_x" ~/.config/conky/conky-top-left.conf; echo',
 'echo "=== 7. LOG ==="; cat /tmp/conky.log; echo',
 'echo "=== 8. SYSTEMD ==="; systemctl --user status conky.service 2>&1 | head -15; echo',
 'echo "=== 9. AMBIENTE DO COSMIC-COMP ==="; tr "\\0" "\\n" < /proc/$(pgrep cosmic-comp | head -1)/environ | grep -E "WAYLAND|XDG_RUNTIME"',
].join("\n");

(async () => {
  let bad=0; const ok=(b,m)=>{console.log((b?"PASS":"FAIL")+" "+m); if(!b)bad++;};
  const cmds = X.extractCommands("```bash\n"+BIG+"\n```");
  ok(cmds.length===1, "parser: 1 comando (got "+cmds.length+")");
  ok(cmds[0]===BIG, "parser: script intacto (len "+cmds[0].length+" vs "+BIG.length+")");
  if (cmds[0]!==BIG) for(let i=0;i<Math.max(cmds[0].length,BIG.length);i++) if(cmds[0][i]!==BIG[i]){console.log("  difere no char "+i+": got "+JSON.stringify(cmds[0].slice(i,i+50))+" exp "+JSON.stringify(BIG.slice(i,i+50)));break;}
  const r = await fetch("http://127.0.0.1:8765/run",{method:"POST",headers:{"Content-Type":"application/json","X-Token":TOK},body:JSON.stringify({sid:"big",cmd:cmds[0]})});
  const j = await r.json();
  console.log("--- EXIT:", j.exit, "| dur:", j.duration_ms+"ms");
  console.log("--- STDERR:", JSON.stringify((j.stderr||"").trim()));
  console.log("=== STDOUT ===\n"+(j.stdout||"(vazio)"));
  process.exit(bad?1:0);
})();
