// test_stream_trunc.cjs — Regressão do bug de truncamento em streaming.
//
// Cenário real: o DeepSeek faz streaming do markdown e ADICIONA o
// .md-code-block ao DOM quando ele começa a existir (primeiras ~250 bytes).
// O codeObserver anexa o botão ▶ nesse instante e `codeFromBlock` devolve só o
// começo do script. Se o clique usar esse texto congelado, o heredoc chega sem
// terminador ao bash:
//   warning: here-document at line 25 delimited by end-of-file (wanted `CONKY')
//
// Correção: o clique re-lê o bloco AO VIVO. Este teste falha se o cmd executado
// não for o script completo renderizado depois do streaming terminar.
const fs = require("fs"), path = require("path");

let codeCb = null;
function mkEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, _children: [], parentNode: null, className: "", id: "", style: {},
    _text: "", onclick: null, dataset: {},
    get innerText() { return this._text; }, set innerText(v) { this._text = v; },
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    classList: { _s: new Set(), add(c){this._s.add(c);}, contains(c){return this._s.has(c);} },
    setAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, removeEventListener(){},
    appendChild(c){ c.parentNode = this; this._children.push(c); return c; },
    insertBefore(n, ref){ n.parentNode = this; const i=this._children.indexOf(ref); this._children.splice(i<0?0:i,0,n); return n; },
    querySelector(sel){ return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel){ const out=[]; (function walk(n){ for(const c of n._children){ if(sel==="pre"&&c.tagName==="pre") out.push(c); if(sel===".aisp-run-btn"&&c.className==="aisp-run-btn") out.push(c); walk(c); } })(this); return out; },
    remove(){ if(this.parentNode){ const a=this.parentNode._children; const i=a.indexOf(this); if(i>=0)a.splice(i,1); } },
  };
  Object.defineProperty(el, "children", { get(){ return this._children; } });
  return el;
}
const docEl = mkEl("html"), body = mkEl("body");
const document = {
  documentElement: docEl, head: mkEl("head"), body,
  createElement: mkEl,
  getElementById: () => null,
  querySelectorAll: () => [], addEventListener: () => {},
  querySelector: () => null,
};
const sent = [];
const sessionStorage = { _s:{}, getItem(k){ return this._s[k] ?? null; }, setItem(k,v){ this._s[k]=String(v); }, removeItem(k){ delete this._s[k]; } };
const chrome = {
  runtime: { getURL:(u)=>u, sendMessage:(m,cb)=>{ sent.push(m); cb&&cb({ok:true,entry:{}}); }, onMessage:{addListener(){}} },
  storage: { local:{ get(){}, set(){} }, onChanged:{ addListener(){} } },
};
const window = { addEventListener(){}, postMessage(){}, __postMessage(){}, __dbg:[] };
class MutationObserver { constructor(cb){ this.cb=cb; } observe(t){ if(t===document.body) codeCb=this.cb; } }

const src = fs.readFileSync(path.join(__dirname,"content.js"),"utf8");
const mod = { exports: {} };
new Function("mod","window","document","chrome","console","MutationObserver","fetch","setTimeout","sessionStorage",
  src + "\nreturn mod.exports;")(mod, window, document, chrome, {log(){},info(){},error(){}}, MutationObserver, ()=>{}, setTimeout, sessionStorage);

// 1) Bloco aparece no DOM em STREAMING: só os primeiros 250 bytes do script.
const block = mkEl("div"); block.classList.add("md-code-block");
const pre = mkEl("pre");
const FULL = "mkdir -p ~/.config/conky\ncat > ~/.config/conky/conky-bottom-left.conf <<'CONKY'\nconky.config = {\n    minimum_width = 230,\n    update_interval = 2.0, use_xft = true,\n    default_color = '#cdd6f4',\n}\nconky.text = [[\n${color}  Top    ${top_mem name 1}\n]]\nCONKY\n";
pre.innerText = FULL.slice(0, 250); // streaming: truncado no meio do token '#cd
block.appendChild(pre);
body.appendChild(block);

// Observer de código anexa o botão no instante da criação (texto parcial).
if (codeCb) codeCb([{ addedNodes: [block] }]);
const btn = block.querySelectorAll(".aisp-run-btn")[0];

// 2) Streaming termina: o DOM recebe o restante do script.
pre.innerText = FULL;

// 3) Clique deve executar o texto AO VIVO (completo), não o capturado no attach.
btn && btn.onclick({ preventDefault(){}, stopPropagation(){} });
const execs = sent.filter(m => m.type === "exec");
const cmd = execs[0] && execs[0].cmd;

const ok = (b,m)=>console.log((b?"PASS":"FAIL"),m);
let bad = 0; const chk=(b,m)=>{ ok(b,m); if(!b) bad++; };
chk(!!btn, "botão ▶ anexado durante o streaming");
chk(execs.length === 1, "clique dispara 1 exec (got " + execs.length + ")");
// O parser normaliza espaços à direita (trailing) — o importante é que o corpo
// do heredoc está INTEIRO e FECHADO, não o byte-a-byte igual a FULL.
chk(cmd === FULL.replace(/\s+$/, ""), "exec usa o script COMPLETO pós-streaming (heredoc fechado)");
chk(cmd && /CONKY\s*$/.test(cmd), "terminador CONKY presente (heredoc não truncado)");
chk(cmd && cmd.includes("default_color = '#cdd6f4'"), "token no meio do bloco não foi cortado");
chk(cmd && cmd.length > 250, "cmd bem maior que o snapshot parcial de streaming (>250b)");

console.log(bad ? `\nstream_trunc: ${bad} falha(s)` : "\nstream_trunc: OK — clique re-lê o bloco ao vivo, sem truncar heredoc");
process.exit(bad ? 1 : 0);
