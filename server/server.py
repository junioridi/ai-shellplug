#!/usr/bin/env python3
"""
ai-shellplug relay server
-------------------------
Ouvinte local que executa comandos de shell disparados pela extensão de browser
(que por sua vez os extrai de blocos ```json {"tool":"exec","cmd":"..."}``` em
páginas de chat de IA como a do DeepSeek).

Superusuário:
- por padrão o servidor exige rodar como root (Linux/Unix). Se iniciado como
  usuário comum, ele se re-executa via `sudo` automaticamente (a menos que
  AISHELLPLUG_REQUIRE_ROOT=0, que apenas avisa).
- cada comando é executado com privilégios de superusuário (euid 0). Se por
  algum motivo o processo não estiver como root, o wrapper usa `sudo -n` para
  elevar o comando.
- desative com AISHELLPLUG_AS_ROOT=0 (executa como o usuário que subiu o server).

Segurança (v1):
- bind só em 127.0.0.1
- token compartilhado obrigatório no header `X-Token`
- shell arbitrário como root (decidido pelo usuário), com timeout e captura de saída
- cada execução é logada (stdout do servidor + arquivo de log)
"""
from __future__ import annotations

import json
import os
import platform
import shutil
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

# Superusuário: por padrão exige root e auto-eleva no boot (Linux/Unix).
AS_ROOT = os.environ.get("AISHELLPLUG_AS_ROOT", "1").strip().lower() not in ("0", "false", "no", "")
REQUIRE_ROOT = os.environ.get("AISHELLPLUG_REQUIRE_ROOT", "1").strip().lower() not in ("0", "false", "no", "")


IS_WINDOWS = platform.system().lower().startswith("win")


def _is_root() -> bool:
    """True se o processo atual tem privilégio de superusuário (root/admin)."""
    if IS_WINDOWS:
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:  # noqa: BLE001
            return False
    return hasattr(os, "geteuid") and os.geteuid() == 0

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

    O comando roda no diretório atual da sessão; ao final, o `pwd` resultante e o
    ambiente (env/set) são gravados no arquivo `sentinel` para que o próximo
    comando parta do mesmo diretório e com as variáveis de ambiente exportadas.

    Superusuário: quando `AS_ROOT` e o processo não é root, prefixa com `sudo -n`
    (não-interativo) para elevar o comando sem travar pedindo senha.
    """
    prefix: list[str] = []
    if AS_ROOT and not _is_root() and not IS_WINDOWS:
        prefix = ["sudo", "-n"]
    if IS_WINDOWS:
        wrapper = (
            f"{cmd}\r\n"
            f"(Get-Location).Path | Out-File -Encoding utf8 '{sentinel}'\r\n"
            f"Get-ChildItem env: | ForEach-Object {{ \"$($_.Name)=$($_.Value)\" }} | "
            f"Out-File -Append -Encoding utf8 '{sentinel}'\r\n"
        )
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", wrapper]
    wrapper = (
        f"{cmd}\n"
        f"__aisp_code=$?\n"
        f"pwd > {sentinel}\n"
        f"env >> {sentinel}\n"
        f"exit $__aisp_code"
    )
    return [*prefix, "bash", "-c", wrapper]


def _parse_sentinel(path: str) -> tuple[str, dict]:
    """Extrai (cwd, env) do arquivo sentinela.

    A 1ª linha é o `pwd`; as demais são `CHAVE=VALOR` do ambiente. Retorna
    cwd="" quando vazio e somente as entradas env com formato válido.
    """
    cwd = ""
    env: dict[str, str] = {}
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return cwd, env
    if lines:
        cwd = lines[0].strip()
    for line in lines[1:]:
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k:
            env[k] = v
    return cwd, env


@app.get("/health")
def health() -> dict:
    root = _is_root()
    _log("health", shell="powershell" if IS_WINDOWS else "bash", root=root)
    return {
        "ok": True,
        "os": platform.system(),
        "shell": "powershell" if IS_WINDOWS else "bash",
        "root": root,
        "euid": (os.geteuid() if hasattr(os, "geteuid") else None),
        "as_root": AS_ROOT,
    }


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

    # Persiste cwd e ambiente (variáveis exportadas) para a próxima execução.
    try:
        if os.path.exists(sentinel):
            new_cwd, new_env = _parse_sentinel(sentinel)
            if new_cwd and os.path.isdir(new_cwd):
                session["cwd"] = new_cwd
            if new_env:
                session["env"] = new_env
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



def _maybe_reexec_as_root() -> None:
    """Se não for root e exigirmos superusuário, re-executa o processo via sudo.

    Usa os.execvp para substituir o processo atual (sem novo pai). Preserva o
    ambiente (que carrega AISHELLPLUG_TOKEN etc.). Só no Linux/Unix.
    """
    if IS_WINDOWS or _is_root() or not AS_ROOT:
        return
    if not REQUIRE_ROOT:
        print(
            "AVISO: servidor NÃO está como root e AISHELLPLUG_REQUIRE_ROOT=0; "
            "comandos tentarão elevar via `sudo -n`.",
            file=sys.stderr,
        )
        return
    if shutil.which("sudo") is None:
        print(
            "ERRO: preciso de root mas `sudo` não foi encontrado. Rode como root "
            "ou defina AISHELLPLUG_REQUIRE_ROOT=0.",
            file=sys.stderr,
        )
        sys.exit(1)
    print("Elevando para root via sudo (re-exec)…", file=sys.stderr)
    try:
        os.execvp("sudo", ["sudo", "-n", sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
    except OSError as exc:  # pragma: no cover
        print(f"ERRO: falha ao elevar via sudo: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    import uvicorn

    if TOKEN == "change-me-local-token":
        print(
            "AVISO: usando token default. Defina AISHELLPLUG_TOKEN antes de expor.",
            file=sys.stderr,
        )

    _maybe_reexec_as_root()
    if AS_ROOT and not _is_root():
        print(
            "AVISO: rodando como usuário comum; comandos usarão `sudo -n` se possível.",
            file=sys.stderr,
        )
    else:
        print(f"ai-shellplug rodando como {'root' if _is_root() else 'usuário'} "
              f"(euid={os.geteuid() if hasattr(os,'geteuid') else 'n/a'})", file=sys.stderr)

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
