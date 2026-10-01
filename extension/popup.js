// popup.js — configuração rápida do relay + visualizador de log
const DEFAULTS = { serverUrl: "http://127.0.0.1:8765", token: "change-me-local-token" };
const $ = (id) => document.getElementById(id);

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLog(entries) {
  const list = $("logList");
  if (!entries || !entries.length) {
    list.innerHTML = '<span class="muted">(vazio)</span>';
    return;
  }
  list.innerHTML = entries
    .map((e) => {
      const lv = `lv-${e.level || "info"}`;
      const msg = String(e.msg).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return `<div class="${lv}">${fmt(e.ts)} [${e.level}] ${msg}</div>`;
    })
    .join("");
  list.scrollTop = list.scrollHeight;
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("serverUrl").value = cfg.serverUrl;
  $("token").value = cfg.token;
  const { aispLog } = await chrome.storage.local.get({ aispLog: [] });
  renderLog(aispLog);
}

$("save").onclick = async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token: $("token").value.trim(),
  });
  $("status").textContent = "salvo ✓";
  setTimeout(() => ($("status").textContent = ""), 1500);
};

$("approveAll").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "approve-all", minutes: 30 });
  $("status").textContent = r && r.ok ? "auto-aprovação ativa por 30 min ✓" : "falha";
};

$("clear").onclick = async () => {
  await chrome.storage.local.set({ aispLog: [] });
  renderLog([]);
};

$("health").onclick = async () => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const el = $("status");
  el.textContent = "testando…";
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/$/, "") + "/health", { method: "GET" });
    const data = await res.json();
    el.textContent = res.ok ? `ok: ${data.os} / ${data.shell}` : `falha HTTP ${res.status}`;
  } catch (e) {
    el.textContent = "falha: " + e;
  }
};

// Atualiza o log em tempo real enquanto o popup está aberto.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.aispLog) renderLog(changes.aispLog.newValue);
});

load();
