#!/usr/bin/env python3
"""
ai-shellplug relay server
-------------------------
Ouvinte local que executa comandos de shell disparados pela extensão de browser
(que por sua vez os extrai de blocos ```json {"tool":"exec","cmd":"..."}``` em
páginas de chat de IA como a do DeepSeek).

Segurança (v1):
- bind só em 127.0.0.1
- token compartilhado obrigatório no header `X-Token`
- shell arbitrário (decisão do usuário: opção "a"), com timeout e captura de saída
- cada execução é logada (stdout do servidor + arquivo de log)
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TOKEN = os.environ.get("AISHELLPLUG_TOKEN", "change-me-local-token")
HOST = os.environ.get("AISHELLPLUG_HOST", "127.0.0.1")
PORT = int(os.environ.get("AISHELLPLUG_PORT", "8765"))
DEFAULT_TIMEOUT = int(os.environ.get("AISHELLPLUG_TIMEOUT", "60"))
LOG_FILE = Path(os.environ.get("AISHELLPLUG_LOG", Path(__file__).parent / "log" / "exec.log"))
LOG_LEVEL = os.environ.get("AISHELLPLUG_LOG_LEVEL", "info").lower()
MAX_LOG_TEXT = int(os.environ.get("AISHELLPLUG_LOG_MAXTEXT", "4000"))


IS_WINDOWS = platform.system().lower().startswith("win")

app = FastAPI(title="ai-shellplug", version="0.1.0")

# A página roda em https://chat.deepseek.com; o fetch é feito pelo service worker
# da extensão (host_permissions), mas liberamos CORS por precaução em dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    cmd: str
    cwd: Optional[str] = None
    timeout: Optional[int] = None


LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_LEVEL = LEVELS.get(LOG_LEVEL, 20)


def _truncate(s: str) -> str:
    if s and len(s) > MAX_LOG_TEXT:
        return s[:MAX_LOG_TEXT] + f"…(+{len(s) - MAX_LOG_TEXT} chars)"
    return s


def _log(event: str, level: str = "info", **fields) -> None:
    """Log estruturado: JSON por linha em arquivo + stdout legível.

    `event` é curto e grep-ável (ex: run.start, run.auth_fail, run.done).
    Campos sensíveis (token) nunca entram aqui.
    """
    if LEVELS.get(level, 20) < _LEVEL:
        return
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "event": event,
        **fields,
    }
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # nunca deixe o log derrubar o servidor
        record["log_error"] = str(exc)
    print(f"[{level}] {event} " + json.dumps(fields, ensure_ascii=False), flush=True)


def _build_argv(cmd: str) -> list[str]:
    if IS_WINDOWS:
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd]
    return ["bash", "-c", cmd]


@app.get("/health")
def health() -> dict:
    _log("health", shell="powershell" if IS_WINDOWS else "bash")
    return {"ok": True, "os": platform.system(), "shell": "powershell" if IS_WINDOWS else "bash"}


@app.post("/run")
def run(
    req: RunRequest,
    request: Request,
    x_token: Optional[str] = Header(default=None),
) -> JSONResponse:
    rid = uuid.uuid4().hex[:8]
    client = request.client.host if request.client else "?"
    cmd = (req.cmd or "").strip()
    cwd = req.cwd or os.getcwd()
    timeout = req.timeout or DEFAULT_TIMEOUT

    _log(
        "run.start",
        rid=rid,
        client=client,
        cmd=_truncate(cmd),
        cwd=cwd,
        timeout=timeout,
        has_token=bool(x_token),
    )

    if not x_token or x_token != TOKEN:
        _log("run.auth_fail", level="warn", rid=rid, client=client, reason="token inválido")
        raise HTTPException(status_code=401, detail="token inválido")

    if not cmd:
        _log("run.bad_request", level="warn", rid=rid, reason="cmd vazio")
        raise HTTPException(status_code=400, detail="cmd vazio")

    started = time.monotonic()
    argv = _build_argv(cmd)
    _log("run.exec", level="debug", rid=rid, argv=argv)

    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        stdout, stderr, code = proc.stdout, proc.stderr, proc.returncode
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = (exc.stderr or "") + f"\n[timeout após {timeout}s]"
        code = 124
        timed_out = True
        _log("run.timeout", level="warn", rid=rid, timeout=timeout, cmd=_truncate(cmd))
    except FileNotFoundError as exc:
        _log("run.shell_missing", level="error", rid=rid, error=str(exc))
        raise HTTPException(status_code=500, detail=f"shell não encontrado: {exc}")
    except Exception as exc:  # noqa: BLE001 — loga qualquer falha inesperada
        _log("run.error", level="error", rid=rid, error=repr(exc))
        raise

    duration_ms = int((time.monotonic() - started) * 1000)
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")

    _log(
        "run.done",
        level="warn" if (code != 0 or timed_out) else "info",
        rid=rid,
        cmd=_truncate(cmd),
        exit=code,
        timed_out=timed_out,
        duration_ms=duration_ms,
        stdout=_truncate(stdout),
        stderr=_truncate(stderr),
    )

    return JSONResponse(
        {
            "rid": rid,
            "exit": code,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
            "stdout": stdout,
            "stderr": stderr,
        }
    )


@app.get("/log")
def tail_log(n: int = 20, x_token: Optional[str] = Header(default=None), level: Optional[str] = None):
    if not x_token or x_token != TOKEN:
        _log("log.auth_fail", level="warn", reason="token inválido")
        raise HTTPException(status_code=401, detail="token inválido")
    if not LOG_FILE.exists():
        return {"lines": []}
    minimum = LEVELS.get(level, 0) if level else 0
    out = []
    for raw in LOG_FILE.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            out.append({"raw": raw})
            continue
        if LEVELS.get(rec.get("level", "info"), 20) >= minimum:
            out.append(rec)
    return {"lines": out[-max(1, n):]}



if __name__ == "__main__":
    import uvicorn

    if TOKEN == "change-me-local-token":
        print(
            "AVISO: usando token default. Defina AISHELLPLUG_TOKEN antes de expor.",
            file=sys.stderr,
        )
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
