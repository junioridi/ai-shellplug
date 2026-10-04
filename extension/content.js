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

  // 2. Ouvir os chunks que o inject.js capturou.
  //
  // IMPORTANTE: o DeepSeek faz streaming do bloco de código em VÁRIOS chunks
  // SSE (cada um com ~300-400 bytes). O código anterior fazia
  //   lastText = ev.data.text
  // substituindo o texto a cada chunk — então maybeRunFromText() só enxergava
  // o último fragmento e o comando chegava truncado. Agora ACUMULAMOS por
  // `kind` e só processamos quando o stream fica inativo (debounce) ou o
  // buffer fica grande, sempre a partir do conteúdo COMPLETO.
  let lastText = "";
  const CHUNK_MAX = 2_000_000; // teto de segurança (mesmo limite do inject.js = 200000)
  const CHUNK_SETTLE_MS = 250; // inatividade mínima p/ considerar o stream terminado
  const bufByKind = Object.create(null);
  const settleTimers = Object.create(null);

  // Extrai os "deltas de texto" de um bloco SSE. Cada linha `data: {json}`
  // pode conter o fragmento do conteúdo do modelo em algum campo string
  // (o DeepSeek usa envelopes JSON variados, ex.: {"v":"...","p":"append"}).
  // Aqui desempacotamos o JSON e CONCATENAMOS os valores string na ordem em
  // que aparecem — é isso que reconstrói o texto do bloco de código, em vez
  // de acumular envelopes JSON crus (que o regex de comando não entende).
  function sseDeltas(raw) {
    const out = [];
    const lines = String(raw || "").split(/\r?\n/);
    for (let ln of lines) {
      if (/^\s*(event:|id:|retry:|:\s)/.test(ln)) continue;
      if (ln.startsWith("data:")) ln = ln.slice(5).replace(/^\s/, "");
      if (!ln) continue;
      const s = ln.trim();
      if (s === "[DONE]") continue;
      if (s.startsWith("{") || s.startsWith("[")) {
        try {
          const obj = JSON.parse(s);
          collectStrings(obj, out);
          continue;
        } catch (_) {
          // JSON partido entre chunks: cai no fallback de texto cru abaixo.
        }
      }
      out.push(ln);
    }
    return out.join("");
  }

  // Varre um objeto JSON concatenando os valores string (deep-first), ignorando
  // chaves/enum de CONTROLE do protocolo (papel, tipo, operacao de stream).
  const CTL_KEYS = new Set(["role", "id", "type", "model", "p", "o", "op", "event", "finish_reason"]);
  const CTL_VALS = new Set(["append", "replace", "assistant", "user", "system", "none", "stop"]);
  function collectStrings(node, out, parentKey) {
    if (node == null) return;
    if (typeof node === "string") {
      if (!CTL_VALS.has(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) { for (const it of node) collectStrings(it, out, parentKey); return; }
    if (typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (CTL_KEYS.has(k)) continue;
        collectStrings(node[k], out, k);
      }
    }
  }

  function stripSseNoise(s) {
    // Mantido por compatibilidade/observabilidade: devolve o texto útil de um
    // blob SSE (sem envelope), usando o mesmo desempacotador dos chunks.
    return sseDeltas(s);
  }

  function onChunk(kind, raw) {
    const text = sseDeltas(raw);
    if (!text) return;
    let buf = bufByKind[kind];
    if (buf == null) buf = "";
    buf += text;
    if (buf.length > CHUNK_MAX) buf = buf.slice(-CHUNK_MAX);
    bufByKind[kind] = buf;
    lastText = buf;
    clog("debug", `chunk (kind=${kind}, +${text.length} bytes, buffer=${buf.length})`);

    clearTimeout(settleTimers[kind]);
    settleTimers[kind] = setTimeout(() => {
      const full = bufByKind[kind] || "";
      bufByKind[kind] = ""; // começa novo ciclo no próximo stream
      if (full) maybeRunFromText(full);
    }, CHUNK_SETTLE_MS);
  }

  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.tag !== TAG) return;
    if (ev.data.kind === "chunk" || ev.data.kind === "ws" || ev.data.kind === "fetch") {
      onChunk(ev.data.kind, ev.data.text || "");
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
    // O hook fetch/WS entrega o texto como esta na stream SSE do DeepSeek:
    // markdown dentro de JSON, com aspas/linhas escapadas. Processa cada
    // variante (desescapada e crua) em SEPARADO e usa a primeira que render
    // comandos; misturar as duas gerava duplicatas quase-iguais
    // (`printf "%s\n" "a` e `printf "%s` + `"a`), o que aparecia como truncado.
    for (const variant of [unescapeSse(text), text]) {
      const out = _extractFromVariant(variant);
      if (out.length) return out;
    }
    return [];
  }

  function _extractFromVariant(variant) {
    const out = [];
    let m;
    const candidates = [];
    FENCED_RE.lastIndex = 0;
    while ((m = FENCED_RE.exec(variant)) !== null) candidates.push(m[1]);
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(variant)) !== null) candidates.push(m[0]);
    SH_FENCED_RE.lastIndex = 0;
    while ((m = SH_FENCED_RE.exec(variant)) !== null) candidates.push({ kind: "sh", body: m[1] });

    for (const raw of candidates) {
      if (raw && typeof raw === "object" && raw.kind === "sh") {
        // Um bloco ```bash/```sh é UM script: executa inteiro, como colado no
        // terminal. NÃO dividir por linha — isso destruiria heredocs
        // (`cat > f <<'EOF' ... EOF`), `set -e`, pipes multilinha e
        // continuações (`\`). Cada fragmento virava um request separado e o
        // heredoc chegava quebrado. Só remove prompts "$ " do início de linha.
        const cmd = raw.body.replace(/^\$ /gm, "").replace(/\s+$/, "");
        if (cmd && !out.includes(cmd)) out.push(cmd);
        continue;
      }
      const cmd = _tryCmd(String(raw).trim());
      if (cmd !== null && !out.includes(cmd)) out.push(cmd);
    }
    return out;
  }

  // Desescapa JSON-string comum vindo do SSE: \" -> "  \\ -> \  \n -> newline.
  // IMPORTANTE: só faz sentido quando o texto é de fato uma stream JSON-escapada
  // (assinatura: contém a sequência \" ou o prefixo \"data:\"). Um bloco de código
  // JÁ renderizado pode conter backslashes LITERAIS (ex.: `tr "\0" "\n"`),
  // e desescapá-lo transformaria o \n de dentro das aspas em quebra de linha,
  // truncando/corrompendo o comando. Sem a assinatura, devolve intacto.
  function unescapeSse(s) {
    if (!s || s.indexOf("\\") === -1) return s;
    if (!/\\"|data:\s*\{/.test(s)) return s; // não parece JSON-escapado
    return s
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }

  // exports completos são definidos no fim do arquivo

  async function maybeRunFromText(text) {
    const cmds = extractCommands(text);
    for (const cmd of cmds) {
      if (!markSeen(cmd)) continue; // duplicata dentro da janela
      // Diagnóstico: guarda o texto-fonte no log para investigar truncamentos
      // de comando (ex.: "cat /tmp/c.txt" chegando como "cat /tmp").
      clog("debug", `comando detectado: ${cmd} | fonte: ${JSON.stringify(String(text).slice(0, 400))}`);
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
    // Mostra o comando INTEIRO (sem cortar/elliptar): comandos longos como
    // "ps -p <pid> -o pid,etime" eram exibidos truncados por nowrap+ellipsis,
    // dando a impressão de execução truncada. Agora quebra linha e é scrollável.
    label.textContent = String(cmd);
    label.style.cssText =
      "color:#7fffd4;margin-right:8px;white-space:pre-wrap;word-break:break-all;" +
      "overflow:auto;max-width:60vw;max-height:6em";
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
  // "Clipboard" = pilha de saídas; cada execução ANEXA. "Limpar" arquiva em history.
  let outputLog = []; // pilha atual (entries/batches na ordem de execução)
  let history = []; // lotes arquivados (cada item = { ts, items: [...] })
  const HIST_KEY = "aisp_output_history"; // persistência em chrome.storage.local
  let lastResult = null; // último retorno (compat)

  function saveHistory() {
    try {
      chrome?.storage?.local?.set?.({ [HIST_KEY]: history.slice(-20) });
    } catch (e) {
      /* storage indisponível (ex.: testes) */
    }
  }

  function loadHistory() {
    try {
      chrome?.storage?.local?.get?.([HIST_KEY], (o) => {
        if (o && Array.isArray(o[HIST_KEY])) history = o[HIST_KEY];
      });
    } catch (e) {
      /* ignora */
    }
  }
  loadHistory();

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
      return;
    }
    // contenteditable (DeepSeek): definir innerText faz o editor rich
    // interpretar "/" como gatilho do menu slash e truncar o texto.
    // Inserimos literalmente via execCommand, que NÃO dispara o atalho.
    el.focus?.();
    const sel = window.getSelection?.();
    if (sel && el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("selectAll", false, null);
      } catch (_) {}
    }
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      // Fallback: ainda usa innerText, mas em nós de texto para evitar o
      // parser do editor enxergar um "/" solto no começo de um nó.
      el.textContent = "";
      el.appendChild(document.createTextNode(text));
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
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
    if (!outputLog.length) {
      clog("info", "clipboard vazio (nada para colar)");
      return false;
    }
    const el = findComposer();
    if (!el) {
      clog("info", "composer não encontrado");
      return false;
    }
    setComposerText(el, PASTE_PREFIX + resultToText(outputLog));
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

  // Converte uma única entry/batch em texto. Usado por entryToText e pela pilha.
  function entryToText(entry) {
    // Comando único.
    if (!entry || !entry.batch) {
      const head = entry.denied
        ? "negado"
        : `exit=${entry.exit} (${entry.duration_ms ?? "?"}ms)${entry.timed_out ? " TIMEOUT" : ""}`;
      const rawNote = entry.raw && entry.raw !== entry.cmd
        ? `### raw do bloco\n${entry.raw}\n### fim raw\n`
        : "";
      return `$ ${entry.cmd}\n${head}\n${rawNote}${entry.stdout || ""}${entry.stderr || ""}`.trim();
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

  function resultToText(entry) {
    // Se receber um array (a pilha), concatena todas as saídas empilhadas.
    if (Array.isArray(entry)) return entry.map((e) => entryToText(e)).join("\n\n");
    return entryToText(entry);
  }

  // Anexa uma entry/batch à pilha (clipboard) e re-renderiza.
  function pushOutput(entry) {
    outputLog.push(entry);
    lastResult = entry;
    injectResult();
  }

  // "Limpar": arquiva a pilha atual no histórico e zera o clipboard/popup.
  function clearOutput() {
    if (outputLog.length) {
      history.push({ ts: Date.now(), items: outputLog });
      saveHistory();
      outputLog = [];
      clog("info", `clipboard limpo (${history[history.length - 1].items.length} bloco(s) arquivado(s))`);
    }
    lastResult = outputLog.length ? outputLog[outputLog.length - 1] : null;
    injectResult();
  }

  // Divisão de um bloco de código em comandos executáveis (uma linha não vazia
  // por comando). Linhas iniciadas por "#" viram comentários "/" e são ignoradas.
  // Divide um bloco em comandos por linha, mas SEM cortar quebras de linha
  // que estejam dentro de aspas simples/duplas (ex.: echo 'a<newline>b').
  function splitBlockCommands(text) {
    const src = String(text || "").replace(/\r/g, "");
    const lines = src.split("\n");
    const out = [];
    let heredoc = null; // { delim, strip }
    let acc = null; // acumulador multi-linha do heredoc
    for (const line of lines) {
      if (heredoc) {
        acc.push(line);
        const probe = heredoc.strip ? line.replace(/^\t+/, "") : line;
        if (probe === heredoc.delim) {
          out.push(acc.join("\n"));
          acc = null;
          heredoc = null;
        }
        continue;
      }
      // Abre heredoc? (<<EOF / <<'EOF' / <<"EOF" / <<-EOF) e nada fecha na linha.
      const m = line.match(/<<(-?)\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\2|([A-Za-z_][A-Za-z0-9_]*))/);
      if (m) {
        heredoc = { delim: m[3] || m[4], strip: m[1] === "-" };
        acc = [line];
        continue;
      }
      // Linha normal: mantém o comportamento antigo — fatia por ';' respeitando
      // aspas/escapes, e cada pedaço é um comando.
      for (const piece of splitOnSemicolons(line)) out.push(piece);
    }
    // Heredoc não fechado (comando truncado): emite o que acumulou, para o bash
    // reportar o erro real em vez de perder o texto.
    if (acc) out.push(acc.join("\n"));
    return out.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  }

  // Fatia UMA linha por ';' respeitando aspas simples/duplas e escapes.
  function splitOnSemicolons(line) {
    const parts = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "\\") {
        cur += ch;
        if (i + 1 < line.length) cur += line[++i];
        continue;
      }
      if (ch === ";") {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  }

  // Executa uma lista de comandos SEQUENCIALMENTE no mesmo sid (preserva cwd/env
  // entre eles), com acumulação de resultados. auto=true pula a aprovação.
  function runBlock(cmds, auto, raw) {
    const list = Array.isArray(cmds) ? cmds.filter(Boolean) : [cmds];
    if (!list.length) return;
    clog("info", `executando bloco (${list.length} comando${list.length > 1 ? "s" : ""})`);
    if (list.length === 1) {
      runCommand(list[0], auto, raw);
      return;
    }
    const batch = { cmd: list.join("\n"), raw: raw || cmds, batch: true, stages: [], done: 0, total: list.length };
    results.push(batch);
    pushOutput(batch);

    const sid = getSid();
    const step = (i) => {
      if (i >= list.length) {
        clog("info", `bloco concluído (${batch.done}/${batch.total})`);
        return;
      }
      const cmd = list[i];
      chrome.runtime.sendMessage({ type: "exec", cmd, auto: !!auto, sid }, (res) => {
        const st = { cmd, raw: raw || cmds, ...res };
        batch.stages.push(st);
        batch.done++;
        lastResult = batch;
        try {
          injectResult();
        } catch (e) {
          clog("warn", `falha ao renderizar resultado: ${e.message}`);
        }
        step(i + 1);
      });
    };
    step(0);
  }

  function runCommand(cmd, auto, raw) {
    clog("info", `enviando exec${auto ? " (auto)" : ""}: ${cmd}`);
    chrome.runtime.sendMessage({ type: "exec", cmd, auto: !!auto, sid: getSid() }, (res) => {
      const entry = { cmd, raw: raw != null ? raw : cmd, ...res };
      results.push(entry);
      try {
        pushOutput(entry);
      } catch (e) {
        clog("warn", `falha ao renderizar resultado: ${e.message}`);
      }
    });
  }

  // 4. Injeção do resultado na página como um "bloco" abaixo do chat.
  //    Agora re-renderiza a PILHA inteira (outputLog) — cada execução anexa.
  function injectResult() {
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
      const mkBtn = (label, titleTxt, onClick) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = titleTxt;
        b.style.cssText =
          "cursor:pointer;padding:1px 7px;border-radius:6px;border:1px solid #555;" +
          "background:#2a2a2a;color:#7fffd4;font:12px/1.3 system-ui,sans-serif";
        b.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onClick();
        };
        return b;
      };
      const clearBtn = mkBtn("🗑", "Limpar (zera o clipboard e o popup)", clearOutput);
      const histBtn = mkBtn("📜", "Histórico (saídas anteriores)", showHistory);
      const scrollBtn = mkBtn("⤓", "Rolar até o último botão ▶ executado", scrollToLastRunButton);
      const toggle = mkBtn("⛶", "Maximizar", () => {
        const full = box.dataset.full === "1";
        if (full) {
          box.style.maxWidth = "420px";
          box.style.maxHeight = "40vh";
          box.style.borderRadius = "8px";
          box.style.right = "12px";
          box.style.bottom = "12px";
          box.dataset.full = "0";
          toggle.textContent = "⛶";
          toggle.title = "Maximizar";
        } else {
          box.style.maxWidth = "100vw";
          box.style.maxHeight = "100vh";
          box.style.borderRadius = "0";
          box.style.right = "0";
          box.style.bottom = "0";
          box.dataset.full = "1";
          toggle.textContent = "🗕";
          toggle.title = "Minimizar";
        }
      });
      bar.appendChild(title);
      bar.appendChild(histBtn);
      bar.appendChild(clearBtn);
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
    // Re-renderiza a PILHA inteira: cada execução anexa ao clipboard.
    body.textContent = "";
    if (!outputLog.length) {
      body.textContent = "(sem saídas — o clipboard foi limpo)";
      return;
    }
    outputLog.forEach((entry) => {
      if (entry.batch) {
        entry.stages.forEach((st) => {
          const h = st.denied
            ? "❌ negado"
            : `exit=${st.exit} (${st.duration_ms ?? "?"}ms)${st.timed_out ? " TIMEOUT" : ""}`;
          body.textContent += `$ ${st.cmd}\n${h}\n${st.stdout || ""}${st.stderr || ""}\n`;
        });
        if (entry.done < entry.total) {
          body.textContent += `… executando ${entry.done}/${entry.total}…\n`;
        }
      } else {
        const head = entry.denied
          ? "❌ negado"
          : `exit=${entry.exit} (${entry.duration_ms ?? "?"}ms)${entry.timed_out ? " TIMEOUT" : ""}`;
        body.textContent += `$ ${entry.cmd}\n${head}\n${entry.stdout || ""}${entry.stderr || ""}\n`;
      }
      // separador entre saídas empilhadas
      body.textContent += "\n────────\n\n";
    });
    box.scrollTop = box.scrollHeight;
  }

  // Painel de histórico: mostra os lotes arquivados pelo "Limpar".
  function showHistory() {
    const modal = document.createElement("div");
    modal.id = "aisp-history-modal";
    modal.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647;" +
      "display:flex;align-items:center;justify-content:center;font:12px/1.5 monospace";
    const panel = document.createElement("div");
    panel.style.cssText =
      "background:#111;color:#0f0;border:1px solid #333;border-radius:8px;" +
      "max-width:80vw;max-height:80vh;overflow:auto;padding:12px 14px;white-space:pre-wrap";

    // Botões: fechar + limpar histórico.
    const hb = document.createElement("div");
    hb.style.cssText = "display:flex;gap:8px;margin-bottom:8px;font-family:system-ui,sans-serif;color:#7fffd4";
    const close = document.createElement("button");
    close.textContent = "✕ fechar";
    close.style.cssText =
      "cursor:pointer;padding:2px 8px;border-radius:6px;border:1px solid #555;background:#2a2a2a;color:#7fffd4";
    close.onclick = () => modal.remove();
    const wipe = document.createElement("button");
    wipe.textContent = "🗑 apagar histórico";
    wipe.style.cssText = close.style.cssText;
    wipe.onclick = () => {
      history = [];
      saveHistory();
      render();
    };
    hb.appendChild(close);
    hb.appendChild(wipe);
    panel.appendChild(hb);

    const content = document.createElement("div");
    panel.appendChild(content);

    function render() {
      content.textContent = "";
      if (!history.length) {
        content.textContent = "(histórico vazio)";
        return;
      }
      history
        .slice()
        .reverse()
        .forEach((lot, idx) => {
          const when = new Date(lot.ts).toLocaleString();
          const n = lot.items.length;
          content.textContent += `── lote ${history.length - idx} · ${when} · ${n} bloco(s) ──\n`;
          lot.items.forEach((it) => {
            content.textContent += resultToText(it) + "\n\n";
          });
        });
    }
    render();
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) modal.remove();
    });
    modal.appendChild(panel);
    document.body.appendChild(modal);
  }

  // 4b. Injeta um botão "Executar" em cada bloco de código (classe md-code-block)
  //     renderizado no chat, permitindo rodar o comando direto pelo clique.
  // Reconstrói o texto de um nó preservando espaços quando o highlighter do
  // site quebra o código em <span>s de tokens (um <span> por token, sem os
  // espaços em nós de texto). Usar só textContent cola os tokens
  // ("ps"+"-p"+"1925604" => "ps-p1925604") e comandos como
  // "ps -p <pid> -o etime" chegavam mutilados ao shell ("ps -").
  function nodeToText(node) {
    if (!node) return "";
    let out = "";
    const kids = node.childNodes || node._children || node.children || [];
    if (!kids || !kids.length) {
      // Folha: usa o texto que tiver (textContent é mais fiel que innerText).
      return node.textContent != null && node.textContent !== ""
        ? node.textContent
        : node.innerText != null
        ? node.innerText
        : node.nodeValue != null
        ? node.nodeValue
        : "";
    }
    // Em blocos de código (PRE/CODE), o highlighter costuma emitir um elemento
    // por LINHA (ex.: <div>, <span>) SEM <br> nem nó de quebra entre eles.
    // Sem inserir "\n" entre filhos-elemento, as linhas colam
    // ("...<<'EOF'[Desktop Entry]...EOF") e heredocs chegam truncados ao bash
    // (warning: "here-document ... delimited by end-of-file").
    // A quebra só se aplica DIRETAMENTE em PRE/CODE: dentro de um <div> da
    // linha, os <span> são tokens da MESMA linha (não devem ser separados).
    const lineCtx = node.tagName === "PRE" || node.tagName === "CODE";
    let prevWasElem = false;
    let seenLine = false;
    for (const ch of kids) {
      if (ch.nodeType === 3 /* texto */) {
        out += ch.nodeValue != null ? ch.nodeValue : ch.textContent || "";
        prevWasElem = false;
      } else if (ch.tagName === "BR") {
        out += "\n";
        prevWasElem = false;
      } else {
        // Em PRE/CODE, cada filho-elemento é UMA linha — inclusive quando vazio
        // (linha em branco entre trechos do heredoc). Inserimos o "\n" antes de
        // TODO filho-elemento após o primeiro, sem colapsar quebras consecutivas,
        // para que um <div></div> vazio produza sua própria linha em branco.
        if (lineCtx && (prevWasElem || out.length > 0 || seenLine)) out += "\n";
        seenLine = true;
        out += nodeToText(ch);
        prevWasElem = true;
      }
    }
    // Se os filhos não produziram nada (ex.: spans vazios), cai no textContent.
    if (!out) out = node.textContent != null ? node.textContent : "";
    return out;
  }

  function codeFromBlock(block) {
    // O texto pode estar num <pre><code>, num <pre>, ou direto no bloco.
    const codeEl = block.querySelector && block.querySelector("pre code, code");
    const pre = block.querySelector && block.querySelector("pre");
    const target = codeEl || pre || block;

    function sanitize(t) {
      return String(t == null ? "" : t)
        .replace(/[\u200b\u200c\u200d\ufeff]/g, "") // zero-width
        .replace(/\u00a0/g, " "); // nbsp
    }

    // 1º caminho estruturado preservando espaços (nós de texto / <br>).
    let text = sanitize(nodeToText(target));
    // 2º fallback fiel ao layout. Em <pre>, o innerText respeita os espaços
    // REAIS do código mesmo quando o highlighter emite um <span> por token
    // SEM nós de espaço entre eles (aí o caminho estruturado cola os tokens).
    if (pre && typeof pre.innerText === "string" && pre.innerText) {
      const preText = sanitize(pre.innerText);
      // Usa o innerText quando o estruturado "colou" tokens (ex.: "ps-p" em vez
      // de "ps -p") — heurística: mesmo comprimento sem espaços e mais espaços
      // no innerText.
      const spacesOf = (s) => (s.match(/\s/g) || []).length;
      if (spacesOf(preText) > spacesOf(text)) text = preText;
    }
    if (!text) text = sanitize(target.textContent != null ? target.textContent : target.innerText || "");
    return text.replace(/\r/g, "").replace(/^\$\s+/gm, "").trimEnd();
  }

  // Deixa o botão ▶ cinza (cor de fundo, borda e texto) para sinalizar que o
  // comando daquele bloco já foi executado. Também memoriza o último botão
  // executado para o "scroll até o último" do popup.
  let lastRunButton = null;

  function grayOutRunButton(btn) {
    if (!btn || !btn.style) return;
    btn.style.background = "#3a3a3a";
    btn.style.borderColor = "#555";
    btn.style.color = "#999";
    btn.style.cursor = "default";
    btn.title = (btn.title ? btn.title + "\n" : "") + "(comando já executado)";
    lastRunButton = btn;
  }

  // Rola a página para que o último botão ▶ executado volte à área visível.
  function scrollToLastRunButton() {
    if (!lastRunButton) {
      clog("warn", "scroll: nenhum botão executado ainda");
      return;
    }
    try {
      lastRunButton.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      // Fallback para navegadores sem scrollIntoView com opções.
      lastRunButton.scrollIntoView();
    }
  }

  // --- Diagnóstico: raw dos blocos ---
  // Guarda, para cada md-code-block visto, o texto interno CRU (o que está no
  // inner do bloco) + o comando que o parser extraiu. Fica em
  // chrome.storage.local.rawBlocks para o popup mostrar e o usuário comparar
  // onde o truncamento acontece.
  const RAW_KEY = "rawBlocks";
  const RAW_MAX = 40;

  function innerOf(block) {
    try {
      return block && (block.innerText != null ? block.innerText : block.textContent) || "";
    } catch (e) {
      return "";
    }
  }

  function captureRawBlock(block, cmd) {
    try {
      const raw = innerOf(block);
      if (!raw) return;
      const rec = { ts: Date.now(), raw, cmd };
      chrome.storage.local.get({ [RAW_KEY]: [] }, (o) => {
        if (chrome.runtime.lastError) return;
        const arr = Array.isArray(o[RAW_KEY]) ? o[RAW_KEY] : [];
        // evita duplicar o mesmo raw colado em sequência (ex.: re-render do stream)
        const last = arr[arr.length - 1];
        if (last && last.raw === raw && last.cmd === cmd) return;
        arr.push(rec);
        chrome.storage.local.set({ [RAW_KEY]: arr.slice(-RAW_MAX) });
      });
      clog("debug", "raw do bloco capturado: " + JSON.stringify(raw).slice(0, 120));
    } catch (e) {
      clog("warn", "captureRawBlock falhou: " + e);
    }
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
      // Diagnóstico de truncamento: guarda o inner cru do bloco e o comando
      // que o parser extraiu, para inspeção no popup.
      captureRawBlock(block, cmd);
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
        // O bloco de código é executado como UM ÚNICO script, exatamente como
        // se colado numa janela de terminal: heredocs, `set -e`, pipes,
        // continuações (`\`) e multilinha são preservados. Quebrar por linha
        // (splitBlockCommands) só vale para linhas independentes do composer
        // (`!cmd`), onde cada linha é de fato um comando avulso.
        //
        // IMPORTANTE: re-lê o texto do bloco AGORA, não o `cmd` capturado quando
        // o botão foi anexado. O bloco pode ter sido lido em pleno streaming SSE
        // (só o começo renderizado) e ficado truncado — ex.: heredoc aberto sem
        // terminador → bash: "here-document ... delimited by end-of-file".
        const live = codeFromBlock(block) || cmd;
        if (live && live !== cmd) captureRawBlock(block, live);
        grayOutRunButton(btn);
        runCommand(live, true, live);
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
    module.exports = { extractCommands, commandsFromUserText, attachComposerWatcher, pasteLastResult, attachPasteLastButton, runCommand, runBlock, splitBlockCommands, codeFromBlock, resultToText, clearOutput, pushOutput, grayOutRunButton, scrollToLastRunButton, getLastResult: () => lastResult, getOutputLog: () => outputLog, getHistory: () => history, maybeRunFromText, stripSseNoise };
  }
})();
