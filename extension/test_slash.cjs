// test_slash.cjs — Investigação: comandos com "/" (paths, URLs) devem ser
// preservados por: extractCommands (SSE/json/fenced), splitBlockCommands e codeFromBlock.
const fs = require("fs");
const path = require("path");

function mkEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, _children: [], parentNode: null, className: "", id: "", style: {}, _text: "", dataset: {},
    get innerText() { return this._text; }, set innerText(v) { this._text = v; },
    get textContent() {
      if (this._children.length) return this._children.map((c) => c.textContent).join("") || this._text;
      return this._text;
    },
    set textContent(v) { this._text = v; this._children = []; },
    classList: { _s: new Set(), add(c){this._s.add(c);}, contains(c){return this._s.has(c);} },
    setAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, removeEventListener(){},
    appendChild(c){ c.parentNode=this; this._children.push(c); return c; },
    insertBefore(n,ref){ n.parentNode=this; const i=this._children.indexOf(ref); this._children.splice(i<0?0:i,0,n); return n; },
    querySelector(sel){ return this.querySelectorAll(sel)[0]||null; },
    querySelectorAll(sel){ const out=[]; (function walk(n){ for(const c of n._children){ if(sel==="pre code, code"&&(c.tagName==="code")) out.push(c); if(sel==="pre"&&c.tagName==="pre") out.push(c); if(sel==="code"&&c.tagName==="code") out.push(c); walk(c);} })(this); return out; },
  };
  return el;
}

const document = {
  documentElement: mkEl("html"), head: mkEl("head"), body: mkEl("body"),
  createElement: mkEl, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
  addEventListener: () => {},
};
const chrome = { runtime: { getURL:(u)=>u, sendMessage(){}, onMessage:{addListener(){}} }, storage:{ local:{ get(){}, set(){} }, onChanged:{addListener(){}} } };
class MutationObserver { constructor(cb){this.cb=cb;} observe(){} }
const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const fakeModule = { exports: {} };
new Function("module","window","document","chrome","console","MutationObserver","fetch","setTimeout","sessionStorage",
  src)(fakeModule,
  { addEventListener(){}, postMessage(){} }, document, chrome, { log(){}, info(){}, error(){} },
  MutationObserver, () => {}, setTimeout, { getItem(){return null;}, setItem(){} });
const X = fakeModule.exports;

let pass = 0, fail = 0;
const ok = (b, m, got) => { if (b) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, got !== undefined ? "-> " + JSON.stringify(got) : ""); } };

// 1. extractCommands com bloco json contendo path
let cmds = X.extractCommands('```json\n{"tool":"exec","cmd":"cat /etc/hosts"}\n```');
ok(cmds.includes("cat /etc/hosts"), "extractCommands preserva / no path (json)", cmds);

// 2. bloco shell com paths e URL
cmds = X.extractCommands("```bash\nls /home/user/docs\necho https://x/y/z\n```");
ok(cmds.includes("ls /home/user/docs"), "extractCommands preserva path no ```bash", cmds);
ok(cmds.includes("echo https://x/y/z"), "extractCommands preserva URL no ```bash", cmds);

// 3. splitBlockCommands
let parts = X.splitBlockCommands("ls /a/b\necho https://h/p");
ok(parts.length === 2 && parts[0] === "ls /a/b" && parts[1] === "echo https://h/p", "splitBlockCommands mantém /", parts);

// 4. codeFromBlock (texto puro)
const block = mkEl("div"); block.classList.add("md-code-block");
const pre = mkEl("pre"); const code = mkEl("code");
code.textContent = "$ cat /etc/os-release\necho done";
pre.appendChild(code); block.appendChild(pre);
ok(X.codeFromBlock(block) === "cat /etc/os-release\necho done", "codeFromBlock mantém / e remove '$ '", X.codeFromBlock(block));

// 5. codeFromBlock com spans do highlighter (textContent deve juntar)
const code2 = mkEl("code");
const s1 = mkEl("span"); s1.textContent = "cat /etc/";
const s2 = mkEl("span"); s2.textContent = "hosts";
code2.appendChild(s1); code2.appendChild(s2);
const pre2 = mkEl("pre"); pre2.appendChild(code2);
const block2 = mkEl("div"); block2.classList.add("md-code-block"); block2.appendChild(pre2);
ok(X.codeFromBlock(block2) === "cat /etc/hosts", "codeFromBlock junta spans do highlighter", X.codeFromBlock(block2));

console.log(`\nslash: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
