// Testa a injeção do botão "Executar" nos blocos .md-code-block
const fs = require("fs");
const path = require("path");

let domNodes = {};
let codeCb = null, moCb = null;

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
    querySelectorAll(sel){ const out=[]; (function walk(n){ for(const c of n._children){ if(sel==="pre"&&c.tagName==="pre") out.push(c); if(sel===".aisp-run-btn"&&c.className==="aisp-run-btn") out.push(c); if(sel===".md-code-block"&&c.classList&&c.classList.contains("md-code-block")) out.push(c); walk(c); } })(this); return out; },
  };
  Object.defineProperty(el, "children", { get(){ return this._children; } });
  return el;
}

let ceCalls=0;
const origCE = mkEl;
const docEl = mkEl("html");
const body = mkEl("body");
const document = {
  documentElement: docEl, head: mkEl("head"), body,
  createElement: mkEl,
  getElementById: (id) => domNodes[id] || null,
  querySelectorAll: () => [], addEventListener: () => {},
};
let lastSent = null;
const sent = [];
const sessionStorage = { _s:{}, getItem(k){ return this._s[k] ?? null; }, setItem(k,v){ this._s[k]=String(v); }, removeItem(k){ delete this._s[k]; } };
const chrome = {
  runtime: { getURL: (u) => u, sendMessage: (m, cb) => { lastSent = m; sent.push(m); cb && cb({ ok:true, entry:{} }); }, onMessage: { addListener(){} } },
  storage: { local: { get(){}, set(){} }, onChanged: { addListener(){} } },
};
const window = { addEventListener(){}, postMessage(){}, __postMessage(){}, __dbg:[], };
class MutationObserver { constructor(cb){ this.cb=cb; } observe(t){ if(t===document.body) codeCb=this.cb; else moCb=this.cb; } }

const src = fs.readFileSync(path.join(__dirname,"content.js"),"utf8");
const mod = { exports: {} };
new Function("mod","window","document","chrome","console","MutationObserver","fetch","setTimeout","sessionStorage",
  src + "\nreturn mod.exports;")(mod, window, document, chrome, { log(){}, info(){}, error(){} }, MutationObserver, () => {}, setTimeout, sessionStorage);

// Monta um bloco .md-code-block com <pre>
const block = mkEl("div"); block.classList.add("md-code-block");
const pre = mkEl("pre"); pre.innerText = "$ ls -al\necho oi";
block.appendChild(pre);
body.appendChild(block);

// Dispara o observer de código com esse bloco adicionado
if (codeCb) codeCb([{ addedNodes: [block] }]);
console.error("DEBUG trace", JSON.stringify(window.__dbg));
console.error("DEBUG createElement calls", ceCalls);
const btn = block.querySelectorAll(".aisp-run-btn")[0];
const ok = (b,m)=>console.log((b?"PASS":"FAIL"),m);
ok(!!btn, "botão Executar injetado no .md-code-block");
btn && btn.onclick({ preventDefault(){}, stopPropagation(){} });
const execs = sent.filter(m => m.type === "exec");
ok(execs.length === 2, "clique dispara um exec por linha (got " + execs.length + ")");
ok(execs.every(m => m.auto === true), "cada exec sem popup (auto:true)");
ok(execs.map(m => m.cmd).join("\n") === "ls -al\necho oi", "cmds extraídos sem o prefixo '$ ' (got: " + JSON.stringify(execs.map(m => m.cmd)) + ")");
ok(execs[0] && execs[0].sid && execs[0].sid === execs[1].sid, "mesmo sid entre comandos do bloco");
