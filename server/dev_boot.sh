#!/usr/bin/env bash
# Sobe o ai-shellplug server como root, com sessões rodando como usuário,
# de forma desacoplada (setsid) e não-interativa (sudo -S com senha via stdin).
#
# Uso:
#   ./dev_boot.sh
# Variáveis (ou /tmp/aisp_tok e /tmp/aisp.pw):
#   AISHELLPLUG_TOKEN          (obrigatória)  token X-Token exigido pelo servidor
#   AISHELLPLUG_SUDO_PASSWORD  senha do sudo (para elevar a root no boot)
#   AISHELLPLUG_SESSION_USER   usuário das sessões (default: junior)
#   AISHELLPLUG_BOOT_LOG       log do boot (default: /tmp/aisp_boot.log)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TOK="${AISHELLPLUG_TOKEN:-$(cat /tmp/aisp_tok 2>/dev/null || true)}"
PW="${AISHELLPLUG_SUDO_PASSWORD:-$(cat /tmp/aisp.pw 2>/dev/null || true)}"
USR="${AISHELLPLUG_SESSION_USER:-junior}"
LOG="${AISHELLPLUG_BOOT_LOG:-/tmp/aisp_boot.log}"

if [ -z "$TOK" ]; then
  echo "ERRO: defina AISHELLPLUG_TOKEN (ou crie /tmp/aisp_tok com o token)." >&2
  exit 1
fi
if [ -z "$PW" ]; then
  echo "AVISO: sem senha do sudo (AISHELLPLUG_SUDO_PASSWORD ou /tmp/aisp.pw);" >&2
  echo "       o boot só funciona se o sudo já estiver cacheado/sem senha." >&2
fi

# mata instância anterior (o backend roda como root → precisa de sudo).
# pkill pelo interpretador do venv + script server.py, aceitando path absoluto
# OU relativo e flags intermediárias (ex.: `-B`). Exclui o wrapper `sudo` (que
# tem o caminho do script, não termina em `server.py`) via `server\.py$`.
PK='python[0-9.]* .*server\.py[[:space:]]*$'
if [ -n "$PW" ]; then
  printf '%s\n' "$PW" | sudo -S -p '' pkill -f "$PK" 2>/dev/null || true
else
  pkill -f "$PK" 2>/dev/null || true
fi
if [ -f /tmp/aisp.pid ]; then
  kill "$(cat /tmp/aisp.pid)" 2>/dev/null || true
fi
# libera a porta 8765 de QUALQUER outro processo (ex.: `python3 -m http.server 8765`),
# que não casaria com o pkill de server.py acima.
if [ -n "$PW" ]; then
  printf '%s\n' "$PW" | sudo -S -p '' fuser -k -TERM 8765/tcp 2>/dev/null || true
else
  fuser -k -TERM 8765/tcp 2>/dev/null || true
fi
# espera o socket 8765 liberar (até ~5s), senão o bind falha com EADDRINUSE.
for _ in $(seq 1 50); do
  ss -ltn 2>/dev/null | grep -q '127\.0\.0\.1:8765' || break
  sleep 0.1
done
sleep 0.5

# A senha NÃO vai no argv (não aparece em ps/pgrep): entra por stdin via `sudo -S`.
printf '%s\n' "$PW" > /tmp/aisp.pw
chmod 600 /tmp/aisp.pw
setsid --fork sudo -S -p '' env \
  AISHELLPLUG_TOKEN="$TOK" \
  AISHELLPLUG_SESSION_USER="$USR" \
  "$HERE/../.venv/bin/python" "$HERE/server.py" \
  >"$LOG" 2>&1 < /tmp/aisp.pw &
echo $! > /tmp/aisp.pid
disown 2>/dev/null || true
# espera o socket 8765 REALMENTE escutar (poll até ~15s). Um sleep fixo é frágil:
# o uvicorn loga "startup complete" ~1s antes do bind, gerando falso negativo.
UP=0
for _ in $(seq 1 150); do
  if ss -ltn 2>/dev/null | grep -q '127\.0\.0\.1:8765'; then UP=1; break; fi
  sleep 0.1
done
echo "=== log ($LOG) ==="
tail -n 5 "$LOG"
echo "=== pid ==="
SERVER_PID="$(pgrep -f '\.venv/bin/python.*server\.py[[:space:]]*$' | tail -1)"
echo "${SERVER_PID:-<não encontrado>}"
if [ "$UP" != 1 ] || [ -z "$SERVER_PID" ]; then
  echo "ERRO: servidor não subiu (sem processo ou porta 8765 não escutando)." >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi
echo "OK: server.py pid=$SERVER_PID escutando em 127.0.0.1:8765"
