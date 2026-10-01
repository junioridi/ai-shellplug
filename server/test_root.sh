#!/usr/bin/env bash
# Testa o servidor: health + run, com e sem sudo (AS_ROOT).
set -u
cd "$(dirname "$0")"
PY=../.venv/bin/python
PORT=8799

run_case() {
  local name="$1" asroot="$2" cmd="$3"
  echo "===== $name (AS_ROOT=$asroot) ====="
  AISHELLPLUG_TOKEN=t0k AISHELLPLUG_PORT=$PORT AISHELLPLUG_AS_ROOT="$asroot" \
    AISHELLPLUG_REQUIRE_ROOT=0 "$PY" server.py >/tmp/srv_$name.log 2>&1 &
  local pid=$!
  sleep 2.2
  echo "-- health:"; curl -s "http://127.0.0.1:$PORT/health"; echo
  echo "-- run [$cmd]:"
  curl -s -X POST "127.0.0.1:$PORT/run" -H 'Content-Type: application/json' \
    -H 'X-Token: t0k' -d "{\"cmd\":\"$cmd\",\"sid\":\"s1\"}"; echo
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
}

run_case noroot 1 'id -u; whoami'
run_case asroot0 0 'id -u; whoami'
echo "===== srv log (noroot) ====="; tail -6 /tmp/srv_noroot.log
