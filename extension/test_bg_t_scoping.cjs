// test_bg_t_scoping.cjs — regressao: `t` (timer do AbortController) precisa
// sobreviver ao bloco `finally`. Declarado com `const` DENTRO do try, o finally
// nao o enxerga -> "ReferenceError: t is not defined" quando o fetch falha.
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

function run(fetchImpl) {
  const responses = [];
  const listeners = [];
  const store = {};
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, AbortController,
    fetch: fetchImpl,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        getURL: () => "x", lastError: null,
      },
      storage: {
        local: {
          get: (d, cb) => Promise.resolve(d && !Array.isArray(d) ? d : {}).then((v) => { if (cb) cb(v); return v; }),
          set: (o) => { Object.assign(store, o); return Promise.resolve(); },
          remove: () => Promise.resolve(),
        },
      },
    },
    Date, Math, JSON, Promise, Object, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: "background.js" });
  return { listeners, responses };
}

function callHandler(listeners, msg) {
  return new Promise((resolve) => {
    const fn = listeners[0];
    fn(msg, {}, (resp) => resolve(resp));
  });
}

(async () => {
  let failed = 0;

  // Caso 1: fetch LANÇA -> deve cair no catch, responder exit:-1, e o finally
  // nao pode explodir com ReferenceError.
  {
    const { listeners } = run(() => { throw new Error("connection refused"); });
    const resp = await callHandler(listeners, { type: "exec", cmd: "echo oi", auto: true, sid: "s" });
    if (resp && resp.ok === false && resp.exit === -1 && /FetchError/.test(resp.stderr || "")) {
      console.log("PASS fetch falhando -> exit:-1 sem ReferenceError");
    } else {
      failed++;
      console.log("FAIL fetch falhando -> resposta inesperada:", JSON.stringify(resp));
    }
  }

  // Caso 2: fetch OK -> caminho feliz continua funcionando (finally roda clearTimeout(t)).
  {
    const { listeners } = run(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ rid: "r", sid: "s", cwd: "/tmp", exit: 0, stdout: "oi\n", stderr: "", timed_out: false, duration_ms: 3 }),
    }));
    const resp = await callHandler(listeners, { type: "exec", cmd: "echo oi", auto: true, sid: "s" });
    if (resp && resp.ok === true && resp.exit === 0 && resp.stdout === "oi\n") {
      console.log("PASS fetch OK -> exit:0 (finally ok)");
    } else {
      failed++;
      console.log("FAIL fetch OK -> resposta inesperada:", JSON.stringify(resp));
    }
  }

  // Caso 3: prova direta do bug antigo — `const` no try, uso no finally.
  {
    let threw = null;
    try {
      (function () {
        try { const t = 1; void t; }
        finally { /* eslint-disable */ try { eval("clearTimeout(t)"); } catch (e) { throw e; } }
      })();
    } catch (e) { threw = e; }
    if (threw && threw.name === "ReferenceError") {
      console.log("PASS confirma: `const t` no try nao e visivel no finally (bug reproduzido no padrao antigo)");
    } else {
      console.log("PASS (nota) JS deste runtime nao reproduz o padrao antigo isoladamente");
    }
  }

  console.log(failed ? "\nBG-T: FALHOU" : "\nBG-T OK");
  process.exit(failed ? 1 : 0);
})();
