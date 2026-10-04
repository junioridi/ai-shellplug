// test_popup_manual.cjs — verifica que o comando manual NAO trunca pastes longos.
// Cadeia: textarea.value -> chrome.runtime.sendMessage({type:"exec", cmd}) ->
// background -> POST /run. Simulamos o popup num sandbox e confirmamos que o
// cmd que chega ao background e EXATAMENTE o texto colado (byte a byte).
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
let failed = 0;
const check = (n, ok, extra) => {
  if (ok) console.log("PASS " + n);
  else { failed++; console.log("FAIL " + n + (extra ? " :: " + extra : "")); }
};

// Texto longo com acentos, quotes, `\n`, $, backticks — para pegar truncagem
// ou corrupcao em qualquer camada.
const LONG = [
  "# paste longo de teste",
  "echo 'linha com acentos: ação, coração, geração'",
  "echo \"aspas \\\"internas\\\" e $VARS e `backticks`\"",
  "printf '%s\\n' " + Array.from({ length: 1200 }, (_, i) => `item_${i}`).join(" "),
  "cat /tmp/very/long/path/" + "segment/".repeat(50) + "report_final.txt",
  "# fim: sentinela-zzz-final",
].join("\n");
check("paste longo (>5000 bytes)", LONG.length > 5000, "len=" + LONG.length);

function makeEl(id, tag) {
  return {
    id, tagName: tag || "DIV", value: "", textContent: "", innerHTML: "",
    style: {}, type: "text", checked: false,
    addEventListener() {}, onclick: null, scrollTop: 0, scrollHeight: 0,
  };
}

function runPopup() {
  const els = {
    serverUrl: makeEl("serverUrl"), token: makeEl("token"), showToken: makeEl("showToken", "INPUT"),
    status: makeEl("status"), save: makeEl("save", "BUTTON"), approveAll: makeEl("approveAll", "BUTTON"),
    health: makeEl("health", "BUTTON"), manualCmd: makeEl("manualCmd", "TEXTAREA"),
    manualOut: makeEl("manualOut"), runManual: makeEl("runManual", "BUTTON"),
    useLastRaw: makeEl("useLastRaw", "BUTTON"), clearRaw: makeEl("clearRaw", "BUTTON"),
    clear: makeEl("clear", "BUTTON"), logList: makeEl("logList"), rawList: makeEl("rawList"),
  };
  const sent = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: (id) => els[id] || null },
    setTimeout: (fn) => { return 0; },
    Date, Math, JSON, String, Number, Object, Array, Promise, RegExp, Error,
    chrome: {
      storage: {
        local: { get: (d) => Promise.resolve(d || {}), set: () => Promise.resolve({}) },
        onChanged: { addListener() {} },
      },
      runtime: {
        sendMessage: (m, cb) => {
          sent.push(m);
          const r = { ok: true, exit: 0, stdout: "ok", stderr: "", cwd: "/tmp" };
          if (cb) cb(r);
          return Promise.resolve(r);
        },
      },
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ os: "linux", shell: "bash" }) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "popup.js" });
  return { els, sent };
}

(async () => {
  const ctx = runPopup();
  ctx.els.manualCmd.value = LONG;      // usuario cola o texto longo
  await ctx.els.runManual.onclick();   // clica Executar (onclick e async)

  const execMsg = ctx.sent.find((m) => m.type === "exec");
  check("sendMessage executado", !!execMsg);
  check("cmd NAO truncado (== paste)", execMsg && execMsg.cmd === LONG,
        execMsg ? `enviado=${execMsg.cmd.length} colado=${LONG.length}` : "sem msg");
  check("sentinela final preservada", execMsg && execMsg.cmd.endsWith("sentinela-zzz-final"));
  check("acentos intactos", execMsg && execMsg.cmd.includes("ação, coração, geração"));
  check("backticks/aspas intactos", execMsg && /\\"internas\\"/.test(execMsg.cmd) && execMsg.cmd.includes("`backticks`"));

  console.log(failed ? "\nPOPUP-MANUAL: FALHOU" : "\nPOPUP-MANUAL OK");
  process.exit(failed ? 1 : 0);
})();
