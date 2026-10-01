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
import tempfile
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

# Estado de shell por sessão (sid). Preserva o diretório de trabalho (e variáveis
# de ambiente exportadas) entre comandos, como num shell interativo. Fica só em
# memória: reiniciar o servidor volta ao cwd inicial.
DEFAULT_SID = "default"
_sessions: dict[str, dict] = {}


def _session(sid: str) -> dict:
    """Retorna (criando se preciso) o estado da sessão `sid`."""
    s = _sessions.get(sid)
    if s is None:
        s = {"cwd": os.getcwd(), "env": {}}
        _sessions[sid] = s
    return s

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
    sid: Optional[str] = None


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


def _build_argv(cmd: str, sentinel: str) -> list[str]:
    """Monta o argv preservando cwd/estado entre comandos via arquivo sentinela.

    O comando roda no diretório atual da sessão; ao final, o `pwd` resultante é
    gravado no arquivo `sentinel` para que o próximo comando parta de lá.
    """
    if IS_WINDOWS:
        wrapper = f"{cmd}\r\n(Get-Location).Path | Out-File -Encoding utf8 '{sentinel}'"
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", wrapper]
    wrapper = f"{cmd}\n__aisp_code=$?\npwd > {sentinel}\nexit $__aisp_code"
    return ["bash", "-c", wrapper]


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
    cmd = req.cmd or ""
    sid = req.sid or DEFAULT_SID
    session = _session(sid)
    # cwd explícito sobrepõe o da sessão (permitindo reset); senão usa o preservado.
    base_cwd = req.cwd or session["cwd"]
    if req.cwd:
        session["cwd"] = req.cwd
    timeout = req.timeout or DEFAULT_TIMEOUT

    _log(
        "run.start",
        rid=rid,
        sid=sid,
        client=client,
        cmd=_truncate(cmd),
        cwd=base_cwd,
        timeout=timeout,
        multiline=("\n" in cmd),
        has_token=bool(x_token),
    )

    if not x_token or x_token != TOKEN:
        _log("run.auth_fail", level="warn", rid=rid, client=client, reason="token inválido")
        raise HTTPException(status_code=401, detail="token inválido")

    if not cmd.strip():
        _log("run.bad_request", level="warn", rid=rid, reason="cmd vazio")
        raise HTTPException(status_code=400, detail="cmd vazio")

    started = time.monotonic()
    sentinel = os.path.join(tempfile.gettempdir(), f"aisp_cwd_{rid}")
    argv = _build_argv(cmd, sentinel)
    env = {**os.environ, **session.get("env", {})}
    _log("run.exec", level="debug", rid=rid, argv=argv, sid=sid)

    try:
        proc = subprocess.run(
            argv,
            cwd=base_cwd,
            env=env,
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

    # Persiste o cwd resultante (após possível `cd`) para a próxima execução.
    try:
        if os.path.exists(sentinel):
            new_cwd = Path(sentinel).read_text(encoding="utf-8", errors="replace").strip().splitlines()
            new_cwd = new_cwd[-1].strip() if new_cwd else ""
            if new_cwd and os.path.isdir(new_cwd):
                session["cwd"] = new_cwd
    finally:
        try:
            os.remove(sentinel)
        except OSError:
            pass

    duration_ms = int((time.monotonic() - started) * 1000)
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")

    _log(
        "run.done",
        level="warn" if (code != 0 or timed_out) else "info",
        rid=rid,
        sid=sid,
        cmd=_truncate(cmd),
        exit=code,
        timed_out=timed_out,
        duration_ms=duration_ms,
        cwd=session["cwd"],
        stdout=_truncate(stdout),
        stderr=_truncate(stderr),
    )

    return JSONResponse(
        {
            "rid": rid,
            "sid": sid,
            "cwd": session["cwd"],
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
