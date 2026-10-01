// test_fetcherr.cjs — Garante que, quando o fetch para o servidor falha
// (servidor fora / CORS / URL errada), o background responde com uma mensagem
// clara (stderr) e exit=-1, em vez de deixar o caller pendurado.
const fs = require("fs");
const path = require("path");
const dir = __dirname;

const store = { aispServerUrl: "http://127.0.0.1:8765", aispToken: "t0k" };
const storage = {
  local: {
    async get(defs) { const o = { ...defs }; for (const k of Object.keys(defs)) if (k in store) o[k] = store[k]; return o; },
    async set(o) { Object.assign(store, o); return true; },
  },
  onChanged: { addListener() {} },
};

let bgHandler = null;
const runtime = {
  getURL: (u) => u,
  sendMessage(msg, cb) { if (bgHandler) bgHandler(msg, {}, (r) => cb && cb(r)); return true; },
  onMessage: { addListener: (f) => (bgHandler = f) },
};

// fetch que sempre falha como o browser faz com host não permitido / fora
global.fetch = async () => { throw new TypeError("Failed to fetch"); };

function load(file) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const fn = new Function("module", "exports", "chrome", "fetch", "console",
    "AbortController", "setTimeout", "clearTimeout", "Date",
    src + "\nreturn module.exports;");
  return fn({ exports: {} }, {}, { runtime, storage }, global.fetch, console,
    AbortController, setTimeout, clearTimeout, Date);
}
load("background.js");

(async () => {
  const ok = (b, m) => console.log((b ? "PASS" : "FAIL"), m);
  let got = null;
  runtime.sendMessage({ type: "exec", cmd: "sudo sysctl vm.swappiness=10", sid: "s1", auto: true }, (r) => (got = r));
  await new Promise((r) => setTimeout(r, 30));

  ok(!!got, "background respondeu (não ficou pendurado)");
  ok(got && got.ok === false, "resp ok=false");
  ok(got && got.exit === -1, "exit=-1");
  ok(got && /FetchError/.test(got.stderr || ""), "stderr indica FetchError");
  ok(got && /127\.0\.0\.1|servidor|host_permissions/.test(got.stderr || ""), "stderr traz dica útil");
  console.log("   stderr:", got && got.stderr);
  console.log("\nsetexit:", got && got.exit === -1 && got.ok === false ? "OK" : "FALHA");
  if (!(got && got.exit === -1)) process.exit(1);
})();
