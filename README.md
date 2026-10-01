# ai-shellplug

Relay local que lê comandos de blocos ` ```json {"tool":"exec","cmd":"..."} ``` `
nas respostas do chat do DeepSeek, pede confirmação e executa no seu servidor local.

## Fluxo
```
página DeepSeek  →  content.js (DOM)  →  confirmação  →  background (service worker)
        →  POST http://127.0.0.1:8765/run (X-Token)  →  bash/powershell
        →  resultado volta e é injetado na página + logado no servidor
```

## Camadas de extensão
- `inject.js` — MAIN world: hooka `fetch`/`WebSocket` (caminho robusto p/ streaming).
- `content.js` — isolado: observa o DOM, extrai o comando, mostra o popup de confirmação.
- `background.js` — service worker: faz o hop p/ `127.0.0.1` (evita mixed-content/CORS),
  mantém o estado "executar tudo até parar".
- `popup.html/js` — config de servidor/token e reset do modo auto.

## Servidor (`server/server.py`, FastAPI)
- bind `127.0.0.1:8765`, token obrigatório no header `X-Token`.
- `POST /run {cmd, cwd?, timeout?}` → `{exit, timed_out, duration_ms, stdout, stderr}`
- `GET /health`, `GET /log?n=20` (também exige token).
- shell: `bash -c` (Linux/macOS) ou `powershell -NoProfile -Command` (Windows).
- log JSONL em `server/log/exec.log`.

### Rodar
```bash
cd server
AISHELLPLUG_TOKEN=seu-token-aqui ../.venv/bin/python server.py
# ou: uvicorn server:app --host 127.0.0.1 --port 8765
```
Variáveis: `AISHELLPLUG_TOKEN`, `AISHELLPLUG_HOST`, `AISHELLPLUG_PORT`,
`AISHELLPLUG_TIMEOUT`, `AISHELLPLUG_LOG`.

## Extensão
1. `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" → pasta `extension/`.
2. No popup, configure servidor e **token** (mesmo do servidor).
3. No DeepSeek, a IA responde com:
   ````md
   ```json
   {"tool":"exec","cmd":"ls -la"}
   ```
   ````
4. O bloco traz um botão **▶ Executar** que roda o comando **imediatamente, sem popup**.
   O resultado é injetado abaixo do bloco e aparece no log do servidor.
   A detecção automática por streaming continua usando o banner
   **Executar / Executar tudo até parar / Ignorar** (com confirmação).
5. Acima do composer aparece o botão **📋 Colar último resultado**: ele insere
   `This is the result of the last command: \n<cmd + saída>` na caixa de mensagem
   e envia, para dar seguimento à conversa com o resultado do último comando.

## Segurança (v1 — shell arbitrário, decisão do usuário)
- Só `127.0.0.1`; token compartilhado.
- Confirmação por padrão; "tudo até parar" desliga a confirmação.
- **Risco:** é shell livre disparado por texto vindo de um site de terceiros.
  Não exponha a porta, use token forte, e revise o modo auto.

- Comandos **multilinha** são aceitos (ex.: `cd /tmp` + `echo ok` no mesmo bloco).
- O **diretório de trabalho é preservado** entre comandos: após um `cd`, o próximo
  comando já parte da nova pasta. O estado é por sessão (`sid`), identificado por
  um id persistente da extensão; reiniciar o servidor volta ao cwd inicial.

## Testes
```bash
node extension/test_parser.js        # parser + manifest + sintaxe JS
node extension/test_e2e.js           # banner de aprovação (detecção por texto)
node extension/test_codeblock.cjs    # botão ▶ Executar (exec auto:true, sem popup)
node extension/test_pastelast.cjs    # botão 📋 Colar último resultado
node extension/test_hotkey.js        # atalho
node extension/test_gatilho.js       # gatilho por texto
node extension/test_sse.js           # parser do stream SSE
curl -s 127.0.0.1:8765/health        # com o servidor de pé
```

## Pendências / frágil por natureza
- Seletores do DeepSeek podem mudar (DOM) → ajustar `scan()` em `content.js`.
- Streaming: hoje a extração é via DOM; o hook de WS (`inject.js`) já existe para
  quem quiser migrar o parser para a rede.
- Desktop (Windows) herdado via `_build_argv`; falta validar localmente.
