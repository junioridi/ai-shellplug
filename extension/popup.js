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
  let cfg;
  try {
    cfg = await chrome.storage.local.get(DEFAULTS);
  } catch (e) {
    $("status").textContent = "erro lendo storage: " + e;
    cfg = DEFAULTS;
  }
  $("serverUrl").value = cfg.serverUrl || "";
  $("token").value = cfg.token || "";
  // mostra o que está de fato salvo, para o usuário conferir
  $("status").textContent = "config atual: token=" + (cfg.token || "(vazio)").slice(0, 6) + "…";
  const { aispLog } = await chrome.storage.local.get({ aispLog: [] });
  renderLog(aispLog);
  const { rawBlocks } = await chrome.storage.local.get({ rawBlocks: [] });
  renderRaw(rawBlocks);
}

// Renderiza o raw (inner) dos md-code-blocks capturados, para diagnosticar
// truncamento. Cada item mostra o texto cru e o comando que o parser extraiu.
function renderRaw(items) {
  const list = $("rawList");
  if (!list) return;
  if (!items || !items.length) {
    list.innerHTML = '<span class="muted">(vazio)</span>';
    return;
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  list.innerHTML = items
    .map((it) => {
      const raw = esc(it.raw || "");
      const cmd = esc(it.cmd || "(nenhum)");
      return `<div class="rawItem">${fmt(it.ts)} <span class="rawCmd">→ ${cmd}</span>\n` +
             `RAW: ${JSON.stringify(raw)}\n${raw}</div>`;
    })
    .join("");
}

// Comando manual: envia direto ao servidor via background, sem passar pelo
// parser, para o usuário testar o comando exato que falhou.
async function runManual() {
  const cmd = $("manualCmd").value;
  const out = $("manualOut");
  if (!cmd.trim()) return;
  out.style.display = "block";
  out.textContent = "executando…";
  const res = await chrome.runtime.sendMessage({ type: "exec", cmd, auto: true });
  if (!res) { out.textContent = "sem resposta do background"; return; }
  const parts = [];
  if (res.denied) parts.push("(negado pelo usuário)");
  if (res.error) parts.push("error: " + res.error);
  if (res.exit !== undefined) parts.push("exit=" + res.exit);
  if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ""));
  if (res.stderr) parts.push("stderr:\n" + res.stderr.replace(/\s+$/, ""));
  out.textContent = parts.join("\n") || "(sem saída)";
}

$("runManual").onclick = runManual;
$("useLastRaw").onclick = async () => {
  const { rawBlocks } = await chrome.storage.local.get({ rawBlocks: [] });
  const last = rawBlocks && rawBlocks[rawBlocks.length - 1];
  if (last) $("manualCmd").value = last.raw;
};
$("clearRaw").onclick = async () => {
  await chrome.storage.local.set({ rawBlocks: [] });
  renderRaw([]);
};

async function save() {
  const serverUrl = $("serverUrl").value.trim();
  const token = $("token").value.trim();
  try {
    await chrome.storage.local.set({ serverUrl, token });
    // confirma relendo o storage
    const back = await chrome.storage.local.get({ serverUrl: "", token: "" });
    const okv = back.token === token;
    $("status").textContent = okv
      ? `salvo ✓ (token=${token ? token.slice(0, 6) + "…" : "(vazio)"})`
      : `NÃO salvou (storage devolveu "${back.token}")`;
    setTimeout(() => ($("status").textContent = ""), 2500);
  } catch (e) {
    $("status").textContent = "erro ao salvar: " + e;
  }
}

$("save").addEventListener("click", save);

// Salva também ao sair do campo / pressionar Enter, sem depender do clique.
for (const id of ["serverUrl", "token"]) {
  $(id).addEventListener("change", save);
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

$("showToken").addEventListener("change", () => {
  $("token").type = $("showToken").checked ? "text" : "password";
});

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
  if (area === "local" && changes.rawBlocks) renderRaw(changes.rawBlocks.newValue);
});

load();
