#!/usr/bin/env bash
# Testa a seleção de usuário de sessão + execução de scripts multi-linha (heredoc).
# Requer rodar como root (ou com sudo) para validar a troca de usuário.
set -u
cd "$(dirname "$0")"
PY=../.venv/bin/python
[ -x "$PY" ] || PY=python3
PORT=8801
TARGET="${AISHELLPLUG_SESSION_USER:-junior}"

start() {
  AISHELLPLUG_TOKEN=t0k AISHELLPLUG_PORT=$PORT \
    AISHELLPLUG_REQUIRE_ROOT=0 \
    AISHELLPLUG_SESSION_USER="$1" \
    "$PY" server.py >/tmp/srv_sess.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "servidor não subiu"; cat /tmp/srv_sess.log; return 1
}
stop() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }

post() {
  curl -s -X POST "127.0.0.1:$PORT/run" -H 'Content-Type: application/json' \
    -H 'X-Token: t0k' --data-binary @- 
}

echo "== health (session_user=$TARGET) =="
start "$TARGET" || exit 1
curl -s "http://127.0.0.1:$PORT/health"; echo

echo "== quem sou eu na sessão (esperado: $TARGET, home dele) =="
python3 - "$PORT" <<'PY'
import json, sys, urllib.request
port = sys.argv[1]
body = json.dumps({"cmd": "whoami; id -un; echo HOME=$HOME", "sid": "s1"}).encode()
req = urllib.request.Request(f"http://127.0.0.1:{port}/run", data=body,
    headers={"Content-Type": "application/json", "X-Token": "t0k"})
print(urllib.request.urlopen(req).read().decode())
PY

echo "== heredoc multi-linha (o bug original) =="
python3 - "$PORT" <<'PY'
import json, sys, urllib.request
port = sys.argv[1]
script = ("cat > /tmp/aisp_heredoc_test.sh <<'EOF'\n"
          "#!/usr/bin/env bash\n"
          "echo linha-1\n"
          "echo linha-2\n"
          "EOF\n"
          "bash /tmp/aisp_heredoc_test.sh\n"
          "wc -l < /tmp/aisp_heredoc_test.sh")
body = json.dumps({"cmd": script, "sid": "s1"}).encode()
req = urllib.request.Request(f"http://127.0.0.1:{port}/run", data=body,
    headers={"Content-Type": "application/json", "X-Token": "t0k"})
print(urllib.request.urlopen(req).read().decode())
PY

echo "== preserva cwd entre comandos =="
python3 - "$PORT" <<'PY'
import json, sys, urllib.request
port = sys.argv[1]
def run(cmd):
    body = json.dumps({"cmd": cmd, "sid": "s1"}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/run", data=body,
        headers={"Content-Type": "application/json", "X-Token": "t0k"})
    return json.loads(urllib.request.urlopen(req).read().decode())
print("cd:", run("cd /tmp && pwd")["stdout"].strip())
print("pwd:", run("pwd")["stdout"].strip())
PY

stop
echo "== log do servidor =="; tail -4 /tmp/srv_sess.log
