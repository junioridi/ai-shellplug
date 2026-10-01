// Testa a extração de comandos de blocos .md-code-block quando o highlighter
// do site quebra o código em <span>s de tokens (bugs de espaço truncado:
// "ps -p <pid> -o etime" chegava como "ps -" / "ps-p<pid>-oetime" ao shell).
const fs = require("fs");
const path = require("path");

let codeCb = null;

function mkEl(tag) {
  const el = {
    tagName: tag, nodeType: 1, _children: [], parentNode: null, className: "", id: "", style: {},
    _text: "", onclick: null, dataset: {},
    // Em <pre> real o innerText é fiel ao layout; no mock derivamos do
    // textContent para simular isso quando não foi setado explicitamente.
    get innerText() { return this._text || (this._inner ?? (this.tagName === "pre" ? this.textContent : "")); },
    set innerText(v) { this._text = v; this._inner = v; },
    // textContent CONCATENA filhos (como no DOM real) — é onde o bug nasce.
    get textContent() {
      return this._children.length
        ? this._children.map((c) => c.textContent).join("")
        : this._text;
    },
    set textContent(v) { this._text = v; this._children = []; },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { c.parentNode = this; this._children.push(c); return c; },
    insertBefore(n, ref) { n.parentNode = this; const i = this._children.indexOf(ref); this._children.splice(i < 0 ? 0 : i, 0, n); return n; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) {
        for (const c of (n._children || [])) {
          if (sel === "pre" && c.tagName === "pre") out.push(c);
          if ((sel === "pre code, code") && c.tagName === "code") out.push(c);
          if (sel === ".aisp-run-btn" && c.className === "aisp-run-btn") out.push(c);
          if (sel === ".md-code-block" && c.classList && c.classList.contains("md-code-block")) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
  };
  Object.defineProperty(el, "children", { get() { return this._children; } });
  return el;
}
function mkText(v) { return { nodeType: 3, nodeValue: v, textContent: v, parentNode: null }; }

const body = mkEl("body");
const document = {
  documentElement: mkEl("html"), head: mkEl("head"), body,
  createElement: mkEl, getElementById: () => null,
  querySelectorAll: () => [], addEventListener: () => {},
};
let sent = [];
const sessionStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const chrome = {
  runtime: { getURL: (u) => u, sendMessage: (m, cb) => { sent.push(m); cb && cb({ ok: true, entry: {} }); }, onMessage: { addListener() {} } },
  storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
};
const window = { addEventListener() {}, postMessage() {}, __postMessage() {} };
class MutationObserver { constructor(cb) { this.cb = cb; } observe(t) { if (t === document.body) codeCb = this.cb; } }

const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const mod = { exports: {} };
new Function("mod", "window", "document", "chrome", "console", "MutationObserver", "fetch", "setTimeout", "sessionStorage",
  src + "\nreturn mod.exports;")(mod, window, document, chrome, { log() {}, info() {}, error() {} }, MutationObserver, () => {}, setTimeout, sessionStorage);

function runBlockWith(buildCode) {
  sent = [];
  const block = mkEl("div"); block.classList.add("md-code-block");
  const pre = mkEl("pre"); const code = mkEl("code"); buildCode(code);
  pre.appendChild(code); block.appendChild(pre); body.appendChild(block);
  if (codeCb) codeCb([{ addedNodes: [block] }]);
  const btn = block.querySelectorAll(".aisp-run-btn")[0];
  if (btn) btn.onclick({ preventDefault() {}, stopPropagation() {} });
  return sent.filter((m) => m.type === "exec").map((m) => m.cmd);
}

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else fail++; console.log((b ? "PASS" : "FAIL") + " " + m); };

// A) spans com nós de texto de espaço (padrão hljs): <span>ps</span> <span>-p</span>...
let gotA = runBlockWith((c) => {
  const toks = ["ps", "-p", "1925604", "-o", "etime"];
  toks.forEach((t, i) => { const s = mkEl("span"); s.textContent = t; c.appendChild(s); if (i < toks.length - 1) c.appendChild(mkText(" ")); });
});
ok(gotA.join("\n") === "ps -p 1925604 -o etime", "A espaços entre spans preservados (got: " + JSON.stringify(gotA) + ")");

// B) code com texto único
let gotB = runBlockWith((c) => { c.textContent = "ps -p 1925604 -o etime"; });
ok(gotB.join("\n") === "ps -p 1925604 -o etime", "B texto único preservado (got: " + JSON.stringify(gotB) + ")");

// C) prefixo "$ " por linha + multiline
let gotC = runBlockWith((c) => { c.textContent = "$ cd /tmp\n$ ps -p 1925604 -o etime\necho ok"; });
ok(gotC.join("\n") === "cd /tmp\nps -p 1925604 -o etime\necho ok", "C prefixo '$ ' removido por linha (got: " + JSON.stringify(gotC) + ")");

// D) tokens separados por nbsp/zero-width (o editor do site injeta esses
//    caracteres invisíveis); precisam virar espaços normais, não colar tokens.
let gotD = runBlockWith((c) => {
  const toks = ["ps", "-p", "1925604", "-o", "etime"];
  toks.forEach((t, i) => {
    const s = mkEl("span"); s.textContent = t; c.appendChild(s);
    if (i < toks.length - 1) c.appendChild(mkText("\u00a0")); // nbsp entre tokens
  });
  c.appendChild(mkText("\u200b")); // zero-width extra
});
ok(gotD.join("\n") === "ps -p 1925604 -o etime", "D nbsp/zero-width normalizados (got: " + JSON.stringify(gotD) + ")");

console.log("\ntokens: " + pass + "/" + (pass + fail));
process.exit(fail ? 1 : 0);
