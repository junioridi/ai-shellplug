// content.js — mundo isolado. Injeta inject.js no MAIN world, observa o DOM,
// encontra blocos ```json {"tool":"exec","cmd":"..."}``` na resposta da IA,
// pede aprovação ao background e injeta o resultado de volta no chat.

(() => {
  const TAG = "__aisp__";

  // Guarda contra dupla injeção: tanto o manifest (document_idle) quanto o
  // reload do service worker podem re-executar este script. Sem isso, o banner
  // e o resultado aparecem duplicados e o state fica inconsistente.
  if (window.__aispLoaded) {
    console.log("[aisp:info] content script já carregado; ignorando duplicata");
    return;
  }
  window.__aispLoaded = true;

  // sid persistente da página: garante cwd/env compartilhados entre comandos
  // do mesmo bloco (e entre execuções da mesma aba), simulando um shell único.
  function getSid() {
    try {
      let sid = sessionStorage.getItem("aisp_sid");
      if (!sid) {
        sid = "p_" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem("aisp_sid", sid);
      }
      return sid;
    } catch (_) {
      if (!window.__aispSid) window.__aispSid = "p_" + Math.random().toString(36).slice(2, 10);
      return window.__aispSid;
    }
  }

  // Envia um log para o background (aparece no popup).
  function clog(level, msg) {
    try {
      chrome.runtime.sendMessage({ type: "log", level, msg });
    } catch (_) {}
    console.log(`[aisp:${level}]`, msg);
  }

  // 1. Injetar o hook no MAIN world (precisa do web_accessible_resources)
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
  clog("info", "content script carregado; inject.js injetado");

  // 2. Ouvir os chunks que o inject.js capturou
  let lastText = "";
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.tag !== TAG) return;
    if (ev.data.kind === "chunk" || ev.data.kind === "ws" || ev.data.kind === "fetch") {
      lastText = ev.data.text || "";
      if (lastText) clog("debug", `chunk recebido (${lastText.length} bytes)`);
      maybeRunFromText(lastText);
    }
  });

  // 2b. Observa o DOM renderizado (caminho confiável: o DeepSeek faz streaming
  //     de markdown no DOM). A cada mutação, re-extrai comandos do texto.
  const mo = new MutationObserver((records) => {
    // Ignora mutações causadas pelo NOSSO próprio box de resultado (evita loop).
    let onlyOurs = true;
    for (const r of records) {
      const t = r.target;
      const node = t && t.nodeType === 1 ? t : t && t.parentElement;
      if (node && node.closest && node.closest("#aisp-result-box")) continue;
      onlyOurs = false;
      break;
    }
    if (onlyOurs) return;
    if (!document.body) return;
    const clone = document.body.cloneNode(true);
    const ourBox = clone.querySelector && clone.querySelector("#aisp-result-box");
    if (ourBox) ourBox.remove();
    const text = clone.innerText || "";
    if (text) maybeRunFromText(text);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // 3. Extrai comandos de blocos ```json {tool,cmd}``` (fenced) OU objeto inline.
  //    Aceita tool "exec" e "shell". Deduplica por cmd.
  const FENCED_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  const INLINE_RE = /\{(?:[^{}]|\{[^{}]*\})*"tool"\s*:\s*"(?:exec|shell)"(?:[^{}]|\{[^{}]*\})*\}/g;
  // Blocos de shell em markdown: ```bash / ```sh / ```shell / ```console
  const SH_FENCED_RE = /```(?:bash|sh|shell|console|zsh)\s*\n([\s\S]*?)```/g;
  // Dedup com janela de tempo: permite re-executar o mesmo comando depois de um
  // tempo, evitando travar para sempre (era um Set global permanente).
  const seen = new Map(); // cmd -> timestamp
  const SEEN_TTL_MS = 8000;
  function markSeen(cmd) {
    const now = Date.now();
    const prev = seen.get(cmd);
    if (prev && now - prev < SEEN_TTL_MS) return false; // ainda é duplicata
    seen.set(cmd, now);
    return true;
  }

  function _tryCmd(raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj.tool === "exec" || obj.tool === "shell") && typeof obj.cmd === "string") {
        return obj.cmd;
      }
    } catch (_) {}
    return null;
  }

  function extractCommands(text) {
    const out = [];
    let m;

    // O hook fetch/WS entrega o texto como está na stream SSE do DeepSeek:
    // markdown dentro de JSON, com aspas/linhas escapadas (\", \n). Desescapa
    // uma passada para que os regexes de bloco fenced/inline casem.
    const candidates = [];
    for (const variant of [text, unescapeSse(text)]) {
      FENCED_RE.lastIndex = 0;
      while ((m = FENCED_RE.exec(variant)) !== null) candidates.push(m[1]);
      INLINE_RE.lastIndex = 0;
      while ((m = INLINE_RE.exec(variant)) !== null) candidates.push(m[0]);
      SH_FENCED_RE.lastIndex = 0;
      while ((m = SH_FENCED_RE.exec(variant)) !== null) candidates.push({ kind: "sh", body: m[1] });
    }

    for (const raw of candidates) {
      if (raw && typeof raw === "object" && raw.kind === "sh") {
        for (const line of raw.body.split(/\n/)) {
          const cmd = line.trim().replace(/^\$\s*/, ""); // remove prompt "$ "
          if (cmd && !cmd.startsWith("#") && !out.includes(cmd)) out.push(cmd);
        }
        continue;
      }
      const cmd = _tryCmd(String(raw).trim());
      if (cmd !== null && !out.includes(cmd)) out.push(cmd);
    }
    return out;
  }

  // Desescapa JSON-string comum vindo do SSE: \" -> "  \\ -> \  \n -> newline.
  function unescapeSse(s) {
    if (!s || s.indexOf("\\") === -1) return s;
    return s
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }

  if (typeof module !== "undefined") {
    module.exports = { extractCommands, commandsFromUserText };
  }

  async function maybeRunFromText(text) {
    const cmds = extractCommands(text);
    for (const cmd of cmds) {
      if (!markSeen(cmd)) continue; // duplicata dentro da janela
      clog("info", `comando detectado: ${cmd}`);
      runCommand(cmd);
    }
  }

  // Fallback de aprovação no DOM: o background publica lastApproval no storage.
  // Mostramos um banner Executar / Executar tudo até parar / Ignorar.
  let pendingId = null;
  let lastShownId = null; // id do último pedido de aprovação já renderizado (dedup)
  function showApproval(id, cmd) {
    pendingId = id;
    clog("info", `banner de aprovação exibido: ${cmd}`);
    let bar = document.getElementById("aisp-approval-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "aisp-approval-bar";
      bar.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483647;" +
        "background:#1b1b1b;color:#eee;font:13px/1.4 system-ui,sans-serif;padding:10px 14px;" +
        "border:1px solid #444;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.5);" +
        "display:flex;gap:8px;align-items:center;max-width:90vw";
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";
    const label = document.createElement("code");
    label.textContent = String(cmd).slice(0, 80);
    label.style.cssText = "color:#7fffd4;margin-right:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw";
    bar.appendChild(label);

    const mk = (txt, approve, auto) => {
      const b = document.createElement("button");
      b.textContent = txt;
      b.style.cssText = "cursor:pointer;padding:4px 10px;border-radius:6px;border:1px solid #555;background:#2a2a2a;color:#eee";
    b.onclick = () => {
        if (auto) chrome.runtime.sendMessage({ type: "approve-all", minutes: 30 });
        chrome.runtime.sendMessage({ type: "answer-approval", id: pendingId, approved: approve });
        bar.remove();
      };
      return b;
    };
    bar.appendChild(mk("Executar", true, false));
    bar.appendChild(mk("Executar tudo até parar", true, true));
    bar.appendChild(mk("Ignorar", false, false));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.lastApproval) return;
    const v = changes.lastApproval.newValue;
    if (!v || !v.id) return;
    if (Date.now() - (v.ts || 0) > 5 * 60_000) return; // pedido expirado
    if (v.id === lastShownId) return; // já renderizado; evita duplicata
    lastShownId = v.id;
    showApproval(v.id, v.cmd);
  });

  // Ao carregar, se houver um pedido de aprovação pendente, mostre-o.
  chrome.storage.local.get({ lastApproval: null }, ({ lastApproval }) => {
    if (lastApproval && lastApproval.id && Date.now() - (lastApproval.ts || 0) < 5 * 60_000) {
      lastShownId = lastApproval.id;
      showApproval(lastApproval.id, lastApproval.cmd);
    }
  });

  // Atalho Ctrl+Q: abre/fecha uma janela (overlay) dentro da própria página.
  function toggleWindow() {
    const existing = document.getElementById("aisp-quick-window");
    if (existing) {
      existing.remove();
      clog("info", "janela Ctrl+Q fechada");
      return;
    }
    const win = document.createElement("div");
    win.id = "aisp-quick-window";
    win.style.cssText =
      "position:fixed;right:16px;top:16px;z-index:2147483647;width:360px;max-height:60vh;" +
      "overflow:auto;background:#1b1b1b;color:#eee;font:13px/1.4 system-ui,sans-serif;" +
      "padding:12px 14px;border:1px solid #444;border-radius:10px;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.55)";
    win.innerHTML =
      "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'>" +
      "<strong>ai-shellplug</strong>" +
      "<button id='aisp-qw-close' style='cursor:pointer;background:#2a2a2a;color:#eee;" +
      "border:1px solid #555;border-radius:6px;padding:2px 8px'>✕</button></div>" +
      "<div style='color:#9a9;font-size:12px'>Atalho <b>Ctrl+Q</b> para abrir/fechar.</div>";
    document.body.appendChild(win);
    win.querySelector("#aisp-qw-close").onclick = () => win.remove();
    clog("info", "janela Ctrl+Q aberta");
  }

  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.key === "q" || ev.key === "Q")) {
        if (ev.repeat) return;
        ev.preventDefault();
        toggleWindow();
      }
    },
    true
  );

  const results = []; // histórico local para exibir
  let lastResult = null; // último retorno de comando (para o botão "colar resultado")

  // 3b. Gatilho por linguagem natural: se a MENSAGEM ENVIADA pelo usuário
  //     contiver uma linha começando com "!" (ex: "!ls -la"), executamos aquele
  //     comando. É o caminho confiável — não depende do formato/json da IA.
  function commandsFromUserText(text) {
    const out = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^!(?:!)?\s*(.+)$/.exec(line); // aceita "!cmd" e "!!cmd"
      if (m && m[1].trim()) out.push(m[1].trim());
    }
    return out;
  }

  // Procura a caixa de texto do chat e escuta Enter (envio da mensagem).
  // --- Botão "colar último resultado" acima do composer ---
  const PASTE_PREFIX = "This is the result of the last command: \n";

  function findComposer() {
    const sels = [
      "textarea#chat-input",
      "textarea[placeholder]",
      "div[contenteditable='true']",
      "[contenteditable='true']",
      "textarea",
    ];
    for (const s of sels) {
      const el = document.querySelector?.(s);
      const box = el && (el.tagName === "TEXTAREA" || el.isContentEditable || el.getAttribute?.("contenteditable") === "true");
      if (box) return el;
    }
    return null;
  }

  function setComposerText(el, text) {
    if (el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function submitComposer(el) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    // Fallback: procura o botão de enviar mais próximo.
    const root = el.closest?.("form") || el.parentElement;
    const send =
      root?.querySelector?.("button[type=submit]") ||
      root?.querySelector?.("[data-testid*='send']") ||
      root?.querySelector?.("button[aria-label*='end']");
    if (send) send.click();
  }

  function pasteLastResult() {
    if (!lastResult) {
      clog("info", "sem último resultado para colar");
      return false;
    }
    const el = findComposer();
    if (!el) {
      clog("info", "composer não encontrado");
      return false;
    }
    setComposerText(el, PASTE_PREFIX + resultToText(lastResult));
    el.focus?.();
    submitComposer(el);
    return true;
  }

  function attachPasteLastButton() {
    // Evita duplicar.
    if (document.querySelector?.("#aisp-paste-last")) return;
    const el = findComposer();
    if (!el || !el.parentNode) return;
    const btn = document.createElement("button");
    btn.id = "aisp-paste-last";
    btn.type = "button";
    btn.textContent = "📋 Colar último resultado";
    btn.style.cssText =
      "display:block;margin:6px 0;padding:4px 10px;border-radius:6px;" +
      "border:1px solid #555;background:#2a2a2a;color:#7fffd4;cursor:pointer;" +
      "font:12px/1.3 system-ui,sans-serif";
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pasteLastResult();
    };
    el.parentNode.insertBefore(btn, el);
  }

  function attachComposerWatcher() {
    // DeepSeek usa textarea ou [contenteditable]. Observamos keydown neles.
    document.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Enter" || ev.shiftKey) return;
        if (ev.isComposing || ev.keyCode === 229) return; // IME (ex: japonês/chinês)
        const el = ev.target;
        if (!el) return;
        const isComposer =
          el.tagName === "TEXTAREA" || (el.isContentEditable === true) || el.getAttribute?.("contenteditable") === "true";
        if (!isComposer) return;
        const text = el.value != null ? el.value : el.innerText || "";
        for (const cmd of commandsFromUserText(text)) {
        if (!markSeen(cmd)) continue;
        clog("info", `comando do usuário (linha !): ${cmd}`);
        runCommand(cmd);
      }
      },
      true
    );
  }

  function resultToText(entry) {
    // Comando único.
    if (!entry || !entry.batch) {
      const head = entry.denied
        ? "negado"
        : `exit=${entry.exit} (${entry.duration_ms ?? "?"}ms)${entry.timed_out ? " TIMEOUT" : ""}`;
      return `$ ${entry.cmd}\n${head}\n${entry.stdout || ""}${entry.stderr || ""}`.trim();
    }
    // Batch: um bloco de código com vários comandos executados em sequência.
    return entry.stages
      .map((st) => {
        const head = st.denied
          ? "negado"
          : `exit=${st.exit} (${st.duration_ms ?? "?"}ms)${st.timed_out ? " TIMEOUT" : ""}`;
        return `$ ${st.cmd}\n${head}\n${st.stdout || ""}${st.stderr || ""}`.trim();
      })
      .join("\n\n");
  }

  // Divisão de um bloco de código em comandos executáveis (uma linha não vazia
  // por comando). Linhas iniciadas por "#" viram comentários "/" e são ignoradas.
  function splitBlockCommands(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  // Executa uma lista de comandos SEQUENCIALMENTE no mesmo sid (preserva cwd/env
  // entre eles), com acumulação de resultados. auto=true pula a aprovação.
  function runBlock(cmds, auto) {
    const list = Array.isArray(cmds) ? cmds.filter(Boolean) : [cmds];
    if (!list.length) return;
    clog("info", `executando bloco (${list.length} comando${list.length > 1 ? "s" : ""})`);
    if (list.length === 1) {
      runCommand(list[0], auto);
      return;
    }
    const batch = { cmd: list.join("\n"), batch: true, stages: [], done: 0, total: list.length };
    results.push(batch);
    lastResult = batch;
    injectResult(batch);

    const sid = getSid();
    const step = (i) => {
      if (i >= list.length) {
        clog("info", `bloco concluído (${batch.done}/${batch.total})`);
        return;
      }
      const cmd = list[i];
      chrome.runtime.sendMessage({ type: "exec", cmd, auto: !!auto, sid }, (res) => {
        const st = { cmd, ...res };
        batch.stages.push(st);
        batch.done++;
        lastResult = batch;
        try {
          injectResult(batch);
        } catch (e) {
          clog("warn", `falha ao renderizar resultado: ${e.message}`);
        }
        step(i + 1);
      });
    };
    step(0);
  }

  function runCommand(cmd, auto) {
    clog("info", `enviando exec${auto ? " (auto)" : ""}: ${cmd}`);
    chrome.runtime.sendMessage({ type: "exec", cmd, auto: !!auto, sid: getSid() }, (res) => {
      const entry = { cmd, ...res };
      results.push(entry);
      lastResult = entry;
      try {
        injectResult(entry);
      } catch (e) {
        clog("warn", `falha ao renderizar resultado: ${e.message}`);
      }
    });
  }

  // 4. Injeta o resultado na página como um "bloco" abaixo do chat
  function injectResult(entry) {
    let box = document.getElementById("aisp-result-box");
    if (!box) {
      box = document.createElement("div");
      box.id = "aisp-result-box";
      // Opacidade 0.6 pedida; o conteúdo continua legível e deixa ver a página.
      box.style.cssText =
        "position:fixed;right:12px;bottom:12px;max-width:420px;max-height:40vh;" +
        "overflow:auto;background:#111;color:#0f0;font:12px/1.4 monospace;" +
        "padding:0;border:1px solid #333;border-radius:8px;z-index:2147483647;" +
        "white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0.6";
      box.style.transition = "opacity .15s ease";
      // Mantém legível ao passar o mouse (recupera opacidade total).
      box.addEventListener("mouseenter", () => { box.style.opacity = "1"; });
      box.addEventListener("mouseleave", () => { box.style.opacity = "0.6"; });

      // Barra de título com botão de maximizar/minimizar.
      const bar = document.createElement("div");
      bar.className = "aisp-result-bar";
      bar.style.cssText =
        "display:flex;align-items:center;gap:6px;position:sticky;top:0;" +
        "background:#1a1a1a;padding:4px 8px;border-bottom:1px solid #333;" +
        "font:12px/1.4 system-ui,sans-serif;color:#7fffd4";
      const title = document.createElement("span");
      title.textContent = "ai-shellplug";
      title.style.cssText = "flex:1;user-select:none";
      const toggle = document.createElement("button");
      toggle.className = "aisp-result-toggle";
      toggle.textContent = "⛶";
      toggle.title = "Maximizar";
      toggle.style.cssText =
        "cursor:pointer;padding:1px 7px;border-radius:6px;border:1px solid #555;" +
        "background:#2a2a2a;color:#7fffd4;font:12px/1.3 system-ui,sans-serif";
      toggle.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const full = box.dataset.full === "1";
        if (full) {
          // Minimizar: volta ao tamanho pequeno.
          box.style.maxWidth = "420px";
          box.style.maxHeight = "40vh";
          box.style.borderRadius = "8px";
          box.style.right = "12px";
          box.style.bottom = "12px";
          box.dataset.full = "0";
          toggle.textContent = "⛶";
          toggle.title = "Maximizar";
        } else {
          // Maximizar: ocupa a tela toda.
          box.style.maxWidth = "100vw";
          box.style.maxHeight = "100vh";
          box.style.borderRadius = "0";
          box.style.right = "0";
          box.style.bottom = "0";
          box.dataset.full = "1";
          toggle.textContent = "🗕";
          toggle.title = "Minimizar";
        }
      };
      bar.appendChild(title);
      bar.appendChild(toggle);

      const body = document.createElement("div");
      body.className = "aisp-result-body";
      body.style.cssText = "padding:8px 10px";
      body.textContent = "";

      box.appendChild(bar);
      box.appendChild(body);
      document.body.appendChild(box);
    }
    const body = box.querySelector(".aisp-result-body") || box;
    // Batch: re-renderiza o conteúdo inteiro (acumulado) a cada etapa.
    if (entry.batch) {
      body.textContent = "";
      entry.stages.forEach((st) => {
        const h = st.denied
          ? "❌ negado"
          : `exit=${st.exit} (${st.duration_ms ?? "?"}ms)${st.timed_out ? " TIMEOUT" : ""}`;
        body.textContent += `$ ${st.cmd}\n${h}\n${st.stdout || ""}${st.stderr || ""}\n\n`;
      });
      if (entry.done < entry.total) {
        body.textContent += `… executando ${entry.done}/${entry.total}…`;
      }
      box.scrollTop = box.scrollHeight;
      return;
    }
    const head = entry.denied
      ? "❌ negado"
      : `exit=${entry.exit} (${entry.duration_ms ?? "?"}ms)${entry.timed_out ? " TIMEOUT" : ""}`;
    body.textContent += `\n$ ${entry.cmd}\n${head}\n${entry.stdout || ""}${entry.stderr || ""}\n`;
    box.scrollTop = box.scrollHeight;
  }

  // 4b. Injeta um botão "Executar" em cada bloco de código (classe md-code-block)
  //     renderizado no chat, permitindo rodar o comando direto pelo clique.
  function codeFromBlock(block) {
    // O texto pode estar num <pre><code>, ou direto no bloco.
    const pre = block.querySelector && block.querySelector("pre");
    const target = pre || block;
    let text = target.innerText || target.textContent || "";
    return text.replace(/\r/g, "").replace(/^\$\s+/gm, "").trimEnd();
  }

  function attachRunButtons(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    const blocks = Array.from(scope.querySelectorAll(".md-code-block"));
    // Inclui o próprio nó, caso ele já seja um bloco (querySelectorAll não o retorna).
    if (scope.classList && scope.classList.contains("md-code-block")) blocks.unshift(scope);
    blocks.forEach((block) => {
      if (block.querySelector && block.querySelector(".aisp-run-btn")) return; // já tem
      const cmd = codeFromBlock(block);
      if (!cmd) return;
      // Só oferece execução para blocos que parecem shell/console.
      if (!/[a-zA-Z]/.test(cmd)) return;
      const btn = document.createElement("button");
      btn.className = "aisp-run-btn";
      btn.textContent = "▶ Executar";
      btn.title = cmd.slice(0, 300);
      btn.style.cssText =
        "cursor:pointer;padding:3px 9px;margin:4px 0;border-radius:6px;" +
        "border:1px solid #555;background:#2a2a2a;color:#7fffd4;" +
        "font:12px/1.3 system-ui,sans-serif";
      btn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // Blocos podem ter múltiplas linhas: cada linha é um comando, executado
        // em sequência (mesmo sid → cwd/env preservados). Sem popup de confirmação.
        runBlock(splitBlockCommands(cmd), true);
      };
      // Insere logo antes do <pre>/bloco, se possível.
      const pre = block.querySelector && block.querySelector("pre");
      if (pre && pre.parentNode) pre.parentNode.insertBefore(btn, pre);
      else block.appendChild(btn);
    });
  }

  // Observa novos blocos de código conforme a IA responde em streaming.
  const codeObserver = new MutationObserver((records) => {
    for (const r of records) {
      if (!r.addedNodes) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("md-code-block")) {
          attachRunButtons(n.parentNode || document);
          attachRunButtons(n); // trata o próprio nó, caso não esteja sob um container observado
        } else if (n.querySelectorAll) {
          attachRunButtons(n);
        }
      }
    }
  });
  if (document.body) {
    codeObserver.observe(document.body, { childList: true, subtree: true });
    attachRunButtons(document); // blocos já existentes
  }

  // 5. Ativa o watcher do composer (linhas "!cmd" enviadas pelo usuário).
  attachComposerWatcher();

  // 6. Botão "colar último resultado" acima do composer (re-tenta quando o composer aparecer).
  attachPasteLastButton();
  let pasteTries = 0;
  const pasteTimer = setInterval(() => {
    attachPasteLastButton();
    if (document.querySelector?.("#aisp-paste-last") || ++pasteTries > 40) clearInterval(pasteTimer);
  }, 500);

  if (typeof module !== "undefined") {
    module.exports = { extractCommands, commandsFromUserText, attachComposerWatcher, pasteLastResult, attachPasteLastButton, runCommand, runBlock, splitBlockCommands, resultToText, getLastResult: () => lastResult };
  }
})();
