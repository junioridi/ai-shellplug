// background.js — service worker MV3
// Faz o hop para o servidor local (ignora CORS/mixed-content da página) e
// coordena a confirmação do usuário antes de executar.

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8765",
  token: "change-me-local-token",
  autoApproveUntil: 0, // timestamp (ms) até quando aprovar tudo automaticamente
  sid: "", // identificador de sessão do shell (persiste cwd entre comandos)
};

async function getCfg() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.sid) {
    cfg.sid = "web-" + Math.random().toString(36).slice(2, 10);
    await chrome.storage.local.set({ sid: cfg.sid });
  }
  return { ...DEFAULTS, ...cfg };
}

// Fila simples de pedidos de confirmação pendentes {id -> {cmd, resolve}}
const pending = new Map();

// Log circular visível no popup (chrome.storage.local.aispLog).
const LOG_MAX = 50;
async function log(level, msg) {
  try {
    const { aispLog } = await chrome.storage.local.get({ aispLog: [] });
    aispLog.push({ ts: Date.now(), level, msg: String(msg).slice(0, 400) });
    while (aispLog.length > LOG_MAX) aispLog.shift();
    await chrome.storage.local.set({ aispLog });
    console.log(`[aisp:${level}]`, msg);
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    try {
      if (msg.type === "exec") {
        const cfg = await getCfg();
        const now = Date.now();
        log("info", `exec pedido${msg.auto ? " (auto)" : ""}: ${msg.cmd}`);

        let approved = now < cfg.autoApproveUntil || msg.auto === true;
        if (!approved) {
          log("info", "aguardando confirmação do usuário…");
          approved = await requestApproval(msg.cmd, cfg);
        }
        if (!approved) {
          log("warn", `negado: ${msg.cmd}`);
          sendResponse({ ok: false, denied: true, exit: -1, stdout: "", stderr: "negado pelo usuário" });
          return;
        }

        log("info", `POST /run → ${cfg.serverUrl}`);
        const res = await fetch(cfg.serverUrl.replace(/\/$/, "") + "/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Token": cfg.token },
          body: JSON.stringify({
            cmd: msg.cmd,
            cwd: msg.cwd,
            timeout: msg.timeout,
            sid: msg.sid || cfg.sid,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          log("error", `HTTP ${res.status}: ${data.detail || ""}`);
          sendResponse({ ok: false, exit: -1, stdout: "", stderr: data.detail || ("HTTP " + res.status) });
          return;
        }
        log("info", `exit=${data.exit} out=${JSON.stringify((data.stdout || "").slice(0, 80))}`);
        sendResponse({ ok: true, ...data });
      } else if (msg.type === "log") {
        log(msg.level || "info", msg.msg);
        sendResponse({ ok: true });
      } else if (msg.type === "approve-all") {
        const minutes = msg.minutes || 30;
        await chrome.storage.local.set({ autoApproveUntil: Date.now() + minutes * 60_000 });
        log("info", `auto-aprovação ativa por ${minutes} min`);
        sendResponse({ ok: true, until: Date.now() + minutes * 60_000 });
      } else if (msg.type === "answer-approval") {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(!!msg.approved);
        }
        // Limpa o pedido para o banner não reaparecer após reload.
        try { await chrome.storage.local.remove("lastApproval"); } catch (_) {}
        sendResponse({ ok: true });
      }
    } catch (e) {
      log("error", `handler: ${e}`);
      sendResponse({ ok: false, exit: -1, stdout: "", stderr: String(e) });
    }
  })();

  return true; // resposta assíncrona
});

// Pedido de confirmação: publica em storage; o content.js renderiza o banner
// (Executar / Executar tudo até parar / Ignorar) e responde via "answer-approval".
function requestApproval(cmd, cfg) {
  return new Promise((resolve) => {
    const id = "req-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    // Timeout: se o usuário não responder, negamos (evita Promise pendurada
    // e o content travado esperando aprovação para sempre).
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        chrome.storage.local.remove("lastApproval").catch(() => {});
        log("warn", `aprovação expirou: ${cmd}`);
        resolve(false);
      }
    }, 120_000);
    pending.set(id, { cmd, resolve, timer });

    // UI de aprovação é renderizada pelo content.js via storage.
    chrome.storage.local.set({ lastApproval: { id, cmd, ts: Date.now() } });
  });
}
