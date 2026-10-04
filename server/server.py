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
import shlex
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

# Diretório onde cada execução é salva ÍNTEGRA (comando + stdout + stderr, sem
# truncar), num JSON por rid. Permite avaliar execuções longas/errôneas depois,
# já que o exec.log guarda só um resumo truncado para leitura rápida.
# 0 = desliga a gravação por execução.
EXEC_DIR = Path(os.environ.get("AISHELLPLUG_EXEC_DIR", Path(__file__).parent / "log" / "exec"))
SAVE_EXECS = os.environ.get("AISHELLPLUG_SAVE_EXECS", "1").strip().lower() not in ("0", "false", "no", "")
# Teto de bytes por arquivo para não encher o disco (0 = sem teto). Comando,
# stdout e stderr são gravados completos até este limite cada.
EXEC_MAX_BYTES = int(os.environ.get("AISHELLPLUG_EXEC_MAX_BYTES", "10000000"))

# Superusuário: por padrão exige root e auto-eleva no boot (Linux/Unix).
AS_ROOT = os.environ.get("AISHELLPLUG_AS_ROOT", "1").strip().lower() not in ("0", "false", "no", "")
REQUIRE_ROOT = os.environ.get("AISHELLPLUG_REQUIRE_ROOT", "1").strip().lower() not in ("0", "false", "no", "")

# Usuário da sessão (Linux/Unix). Quando o servidor roda como root, os comandos
# NÃO devem rodar como root por padrão — isso quebra `systemctl --user`, grava em
# /root em vez do home do usuário e cria arquivos com dono errado. Se definido
# (ou autodetectado), cada comando roda com `sudo -u <user> -i`, numa sessão de
# login que preserva HOME, XDG_* e systemd --user.
#
# Precedência: AISHELLPLUG_SESSION_USER (explícito) → SUDO_USER → dono do diretório
# de onde o servidor foi iniciado → DEFAULT_SESSION_USER (fallback fixo). Vazio = não
# troca de usuário.
SESSION_USER = os.environ.get("AISHELLPLUG_SESSION_USER", "").strip()
# Fallback quando somos root mas nenhum alvo foi detectado. Garante que os comandos
# sempre rodem como este usuário em vez de root.
DEFAULT_SESSION_USER = os.environ.get("AISHELLPLUG_DEFAULT_SESSION_USER", "junior").strip()

# Senha para o sudo não-interativo (`sudo -S`). Usada tanto para auto-elevar o
# servidor no boot quanto para trocar de usuário por comando. Vazia = sem senha
# (depende de NOPASSWD ou de já sermos root).
SUDO_PASSWORD = os.environ.get("AISHELLPLUG_SUDO_PASSWORD", "")
if not SUDO_PASSWORD:
    # Fallback: senha deixada pelo dev_boot.sh em /tmp/aisp.pw (o boot não a
    # repassa via env para não vazar em `ps`).
    try:
        _pwfile = Path(tempfile.gettempdir()) / "aisp.pw"
        if _pwfile.is_file():
            SUDO_PASSWORD = _pwfile.read_text(encoding="utf-8").strip()
    except Exception:  # noqa: BLE001
        pass


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


def _resolve_session_user() -> str:
    """Descobre como qual usuário executar os comandos quando somos root.

    Ordem: AISHELLPLUG_SESSION_USER → SUDO_USER → dono do cwd de onde o servidor
    subiu → DEFAULT_SESSION_USER. Retorna "" se não houver alvo (ex.: já somos o
    usuário, ou não é root).
    """
    if IS_WINDOWS:
        return ""
    if SESSION_USER:
        return SESSION_USER
    if not _is_root():
        # Já rodamos como usuário comum: não há troca a fazer.
        return ""
    sudo_user = os.environ.get("SUDO_USER", "").strip()
    if sudo_user and sudo_user != "root":
        return sudo_user
    # Sem SUDO_USER: usa o dono do diretório de trabalho inicial.
    try:
        import pwd

        st = os.stat(os.getcwd())
        ent = pwd.getpwuid(st.st_uid)
        if ent.pw_name and ent.pw_name != "root":
            return ent.pw_name
    except Exception:  # noqa: BLE001
        pass
    # Fallback: garante que comandos rodem como o usuário padrão, não root.
    if DEFAULT_SESSION_USER:
        import pwd

        try:
            pwd.getpwnam(DEFAULT_SESSION_USER)
            return DEFAULT_SESSION_USER
        except KeyError:
            pass
    return ""


SESSION_USER_RESOLVED = _resolve_session_user()


def _user_home(user: str) -> str:
    """Home do usuário-alvo (para cwd inicial e validação). Vazio se desconhecido."""
    if not user:
        return ""
    try:
        import pwd

        return pwd.getpwnam(user).pw_dir
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------------------
# sudo askpass: quando a sessão roda como usuário comum e o usuário digita
# `sudo ...` dentro do comando, não há TTY para ler a senha. Criamos um helper
# (SUDO_ASKPASS) + um wrapper `sudo` no PATH da sessão que usa `sudo -A`, de modo
# que a senha é injetada automaticamente, sem interação.
# ---------------------------------------------------------------------------
_ASKPASS_DIR = Path(tempfile.gettempdir()) / "aisp_askpass"
_askpass_ready = False


def _ensure_askpass(user: str) -> str:
    """Cria (uma vez) o helper de senha + wrapper `sudo`; devolve o dir do bin.

    O helper e o arquivo de senha ficam com dono/permissão do usuário-alvo
    (junior), pois o `sudo` executa o SUDO_ASKPASS como o usuário chamador.
    O wrapper `sudo` intercepta `sudo` digitado no comando e acrescenta `-A`.

    Retorna "" se não há senha configurada ou não há usuário-alvo.
    """
    global _askpass_ready
    if IS_WINDOWS or not SUDO_PASSWORD or not user:
        return ""
    bindir = _ASKPASS_DIR / "bin"
    helper = _ASKPASS_DIR / "askpass.sh"
    passfile = _ASKPASS_DIR / "pw"
    wrapper = bindir / "sudo"
    try:
        _ASKPASS_DIR.mkdir(mode=0o711, exist_ok=True)
        bindir.mkdir(mode=0o755, exist_ok=True)
        passfile.write_text(SUDO_PASSWORD + "\n", encoding="utf-8")
        passfile.chmod(0o600)
        helper.write_text(
            "#!/bin/sh\n"
            f"cat {shlex.quote(str(passfile))}\n",
            encoding="utf-8",
        )
        helper.chmod(0o755)
        wrapper.write_text(
            "#!/bin/sh\n"
            "# wrapper: injeta -A (askpass) no sudo da sessão\n"
            'exec /usr/bin/sudo -A "$@"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        # Dá ao usuário-alvo acesso ao dir, helper e arquivo de senha (é ele quem
        # executa o helper, via sudo). Mantém 600 no arquivo para os demais.
        import pwd

        ent = pwd.getpwnam(user)
        os.chown(_ASKPASS_DIR, ent.pw_uid, ent.pw_gid)
        os.chown(bindir, ent.pw_uid, ent.pw_gid)
        os.chown(helper, ent.pw_uid, ent.pw_gid)
        os.chown(passfile, ent.pw_uid, ent.pw_gid)
        os.chown(wrapper, ent.pw_uid, ent.pw_gid)
        _askpass_ready = True
        return str(bindir)
    except Exception as exc:  # noqa: BLE001
        _log("askpass.setup_fail", level="warn", error=str(exc))
        return ""

# Estado de shell por sessão (sid). Preserva o diretório de trabalho (e variáveis
# de ambiente exportadas) entre comandos, como num shell interativo. Fica só em
# memória: reiniciar o servidor volta ao cwd inicial.
DEFAULT_SID = "default"
_sessions: dict[str, dict] = {}


def _session(sid: str) -> dict:
    """Retorna (criando se preciso) o estado da sessão `sid`."""
    s = _sessions.get(sid)
    if s is None:
        base = _user_home(SESSION_USER_RESOLVED) or os.getcwd()
        if not os.path.isdir(base):
            base = os.getcwd()
        s = {"cwd": base, "env": {}}
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


def _open_heredoc(cmd: str) -> str | None:
    """Detecta um heredoc ABERTO (sem terminador) — sintoma de cmd truncado.

    Um heredoc `<<'EOF'` / `<<EOF` precisa que a linha do terminador apareça
    depois. Se o cmd foi cortado no meio (ex.: leitura parcial do streaming SSE
    pelo cliente), o bash lê até o EOF e emite
    ``warning: here-document ... delimited by end-of-file``. Retornamos o
    marcador pendente (para log) ou None se tudo fechar / não houver heredoc.

    Heurística: rastreia os `<<[-]?['"]?MARKER` e conta aberturas/fechamentos
    por marcador, na ordem em que aparecem. `<<<` (here-string) é ignorado.
    """
    import re as _re
    pending: list[str] = []
    # Só linhas "de controle": evita falsos positivos dentro de strings com <<.
    for raw in cmd.splitlines():
        line = raw.rstrip("\r")
        stripped = line.strip()
        if pending and stripped == pending[-1]:
            pending.pop()
            continue
        for m in _re.finditer(r"(?<!<)<<(?!<)[-]?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", line):
            pending.append(m.group(2))
    return pending[-1] if pending else None


def _save_exec(record: dict) -> str:
    """Grava a execução COMPLETA (cmd + stdout + stderr, sem truncar) num JSON.

    Um arquivo por rid em EXEC_DIR, nomeado `<ts>_<rid>.json` para ordenar
    cronologicamente e ficar fácil de abrir/listar depois. Retorna o caminho
    relativo gravado (ou "" se desligado/erro). Nunca derruba o servidor: falhas
    de escrita viram um aviso no log.
    """
    if not SAVE_EXECS:
        return ""
    rid = record.get("rid") or uuid.uuid4().hex[:8]
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    name = f"{ts}_{rid}.json"

    def _cap(s: str) -> str:
        if EXEC_MAX_BYTES and len(s) > EXEC_MAX_BYTES:
            return s[:EXEC_MAX_BYTES] + f"\n…(+{len(s) - EXEC_MAX_BYTES} bytes truncados pelo teto EXEC_MAX_BYTES)"
        return s

    cmd = _cap(record.get("cmd", ""))
    bad_heredoc = _open_heredoc(cmd)
    payload = {
        "rid": rid,
        "ts": datetime.now(timezone.utc).isoformat(),
        "cmd": cmd,
        "cwd": record.get("cwd", ""),
        "sid": record.get("sid", ""),
        "user": record.get("user", ""),
        "exit": record.get("exit"),
        "timed_out": record.get("timed_out", False),
        "duration_ms": record.get("duration_ms"),
        "stdout": _cap(record.get("stdout", "")),
        "stderr": _cap(record.get("stderr", "")),
    }
    if bad_heredoc:
        # Sinal explícito de cmd provavelmente truncado no cliente (herança do
        # bug de streaming). Fica no log e no JSON para diagnóstico.
        payload["bad_heredoc"] = bad_heredoc
        _log("run.bad_heredoc", level="warn", rid=rid,
             marker=bad_heredoc, cmd_bytes=len(payload["cmd"]))
    try:
        EXEC_DIR.mkdir(parents=True, exist_ok=True)
        path = EXEC_DIR / name
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        # Espelha o caminho no exec.log para correlacionar resumo <-> íntegra.
        _log("run.saved", rid=rid, file=name, cmd_bytes=len(payload["cmd"]),
             stdout_bytes=len(payload["stdout"]), stderr_bytes=len(payload["stderr"]))
        return name
    except OSError as exc:  # noqa: BLE001
        _log("run.save_fail", level="warn", rid=rid, error=str(exc))
        return ""


def _build_script(cmd: str, sentinel: str, session_env: dict | None = None,
                  cwd: str = "", askpass_bin: str = "") -> str:
    """Script bash que roda `cmd`, grava pwd+env no sentinel e propaga o exit code.

    Passado por stdin (não via `-c`), o que preserva heredocs e qualquer estrutura
    multi-linha exatamente como o usuário escreveu.

    `session_env`/`cwd` são o estado herdado da sessão: são reaplicados DENTRO do
    script porque `sudo -u` limpa o ambiente e ignora o cwd do processo pai.

    `askpass_bin`, quando dado, é preposto ao PATH e o script exporta
    `SUDO_ASKPASS`, para que `sudo` digitado pelo usuário leia a senha sem TTY.
    """
    if IS_WINDOWS:
        return (
            f"{cmd}\r\n"
            f"(Get-Location).Path | Out-File -Encoding utf8 '{sentinel}'\r\n"
            f"Get-ChildItem env: | ForEach-Object {{ \"$($_.Name)=$($_.Value)\" }} | "
            f"Out-File -Append -Encoding utf8 '{sentinel}'\r\n"
        )
    preamble = ""
    if cwd:
        preamble += f"cd {shlex.quote(cwd)} 2>/dev/null || true\n"
    if askpass_bin:
        # PATH primeiro: o wrapper `sudo` do bindir passa a ter prioridade.
        preamble += f"export PATH={shlex.quote(askpass_bin)}:\"$PATH\"\n"
        preamble += (
            "export SUDO_ASKPASS="
            f"{shlex.quote(str(_ASKPASS_DIR / 'askpass.sh'))}\n"
        )
    for key, value in (session_env or {}).items():
        if key.isidentifier():
            preamble += f"export {key}={shlex.quote(value)}\n"
    return (
        preamble
        + f"{cmd}\n"
        f"__aisp_code=$?\n"
        f"pwd > {sentinel}\n"
        f"env >> {sentinel}\n"
        f"exit $__aisp_code\n"
    )


def _build_argv(user: str = "") -> list[str]:
    """Monta o argv do shell que lê o script de stdin.

    `user` (Linux/Unix): quando o servidor roda como root e há um usuário-alvo,
    executa via `sudo -H -u <user> bash` — shell NÃO-login que lê o script da
    stdin de forma determinística (`-H` define HOME). Não usamos `bash -l`: a
    shell de login lê /etc/profile + rcs do alvo e pode imprimir/rodar lixo no
    stderr de toda execução (poluindo o popup). Se não formos root, prefixa `sudo -S`/`-n`
    para elevar (a senha, quando houver, entra pelo stdin e não pelo argv). Sem
    `user`, roda como o usuário atual.

    O script em si vai por stdin, então heredocs e multi-linha funcionam. Quando
    o prefixo é `sudo -S`, a primeira linha do stdin é a senha (ver `_build_stdin`);
    quando já somos root e trocamos de usuário, NÃO usamos `-S` (a senha vazaria
    para a shell interna) nem `-i` (modo interativo descarta o stdin).
    """
    if IS_WINDOWS:
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"]
    if user and _is_root():
        # Já somos root: `sudo -u` não pede senha, então NUNCA use -S aqui —
        # a senha iria vazar para a shell interna como um comando inválido.
        # -H: define HOME para o alvo. `bash` (SEM -l): lê o script da stdin de
        # forma determinística. Shell de login (`bash -l`) executa /etc/profile e
        # ~/.bashrc/~/.profile do alvo, cujo conteúdo pode imprimir/rodar lixo e
        # poluir o stderr de TODA execução (visto como "command not found" no
        # popup). Não usar `-i` (sudo nem `bash -i`): modo interativo descarta o
        # stdin e o script não roda.
        return ["sudo", "-H", "-u", user, "bash"]
    prefix: list[str] = []
    if AS_ROOT and REQUIRE_ROOT and not _is_root():
        # Só elevamos com `sudo -n` quando root é de fato REQUERIDO. Se o
        # operador subiu o servidor com AISHELLPLUG_REQUIRE_ROOT=0, ele optou
        # por NÃO rodar como root — então não faz sentido prepender `sudo -n`
        # (que só gera "sudo: a password is required" no stderr do popup).
        # Nunca coloque a senha na stdin: ela e o script disputariam a MESMA
        # stdin e o bash executaria a senha como comando.
        prefix = ["sudo", "-n"]
    return [*prefix, "bash", "-c", "bash"]


def _needs_sudo_password(argv: list[str]) -> bool:
    """True se o argv usa `sudo -S` (senha pela stdin), exigindo prefixo da senha."""
    return "sudo" in argv[:1] and "-S" in argv


def _build_stdin(argv: list[str], script: str) -> str:
    """Devolve o script puro para a stdin.

    A senha NUNCA entra por aqui: elevamos sempre com `sudo -n` (ver
    `_build_argv`), então a stdin fica 100% dedicada ao script.
    """
    return script


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
        "session_user": SESSION_USER_RESOLVED or None,
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
    who = SESSION_USER_RESOLVED
    argv = _build_argv(who)
    # Askpass: permite `sudo` digitado pelo usuário dentro do comando ler a senha.
    askpass_bin = _ensure_askpass(who) if who else ""
    script = _build_script(
        cmd, sentinel, session.get("env") or {}, base_cwd, askpass_bin=askpass_bin
    )
    stdin = _build_stdin(argv, script)
    env = {**os.environ, **session.get("env", {})}
    # `sudo -A`: aponta o askpass para o helper (a stdin fica só com o script).
    if argv[:1] == ["sudo"] and "-A" in argv and askpass_bin:
        env["SUDO_ASKPASS"] = os.path.join(askpass_bin, "askpass.sh")
    # Com troca de usuário via `sudo -u`, o cwd do subprocesso é o do root; para
    # preservar o cwd da sessão usamos o cwd inicial só quando não há troca de
    # usuário. Com troca, o cwd persistido é reaplicado DENTRO do script (cd ...).
    run_cwd = base_cwd if not who else None
    # Garante que o sentinela seja gravável pelo usuário-alvo.
    if who:
        try:
            fd = os.open(sentinel, os.O_CREAT | os.O_WRONLY, 0o666)
            os.close(fd)
            import pwd

            ent = pwd.getpwnam(who)
            os.chown(sentinel, ent.pw_uid, ent.pw_gid)
        except Exception as exc:  # noqa: BLE001
            _log("run.sentinel_perm", level="warn", rid=rid, error=str(exc))
    _log("run.exec", level="debug", rid=rid, argv=argv, sid=sid, user=who or "(atual)")

    try:
        proc = subprocess.run(
            argv,
            cwd=run_cwd,
            env=env,
            input=stdin,
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

    # Grava a execução ÍNTEGRA (cmd+stdout+stderr) para avaliação posterior.
    _save_exec(
        {
            "rid": rid,
            "sid": sid,
            "cmd": cmd,
            "cwd": session["cwd"],
            "user": SESSION_USER_RESOLVED or "",
            "exit": code,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
            "stdout": stdout,
            "stderr": stderr,
        }
    )

    return JSONResponse(
        {
            "rid": rid,
            "sid": sid,
            "cwd": session["cwd"],
            "user": SESSION_USER_RESOLVED or None,
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


def _check_token(x_token: Optional[str]) -> None:
    if not x_token or x_token != TOKEN:
        _log("auth.fail", level="warn", reason="token inválido")
        raise HTTPException(status_code=401, detail="token inválido")


@app.get("/execs")
def list_execs(n: int = 50, x_token: Optional[str] = Header(default=None)):
    """Lista as execuções salvas (mais recentes primeiro), com metadados leves."""
    _check_token(x_token)
    if not EXEC_DIR.exists():
        return {"enabled": SAVE_EXECS, "dir": str(EXEC_DIR), "execs": []}
    items = []
    for p in sorted(EXEC_DIR.glob("*.json"), reverse=True):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append({
            "file": p.name,
            "rid": rec.get("rid"),
            "ts": rec.get("ts"),
            "exit": rec.get("exit"),
            "timed_out": rec.get("timed_out", False),
            "duration_ms": rec.get("duration_ms"),
            "cwd": rec.get("cwd"),
            "user": rec.get("user"),
            "cmd_preview": (rec.get("cmd", "") or "")[:200],
            "cmd_bytes": len(rec.get("cmd", "") or ""),
            "stdout_bytes": len(rec.get("stdout", "") or ""),
            "stderr_bytes": len(rec.get("stderr", "") or ""),
        })
    return {"enabled": SAVE_EXECS, "dir": str(EXEC_DIR), "execs": items[: max(1, n)]}


@app.get("/exec/{name}")
def get_exec(name: str, x_token: Optional[str] = Header(default=None)):
    """Devolve a execução COMPLETA (cmd+stdout+stderr, sem truncar) pelo nome."""
    _check_token(x_token)
    # Só aceita o basename para impedir path traversal.
    safe = Path(name).name
    if safe != name or not safe.endswith(".json"):
        raise HTTPException(status_code=400, detail="nome inválido")
    path = EXEC_DIR / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="execução não encontrada")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"falha ao ler: {exc}") from exc


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
        os.execvp(
            "sudo",
            ["sudo", "-n", sys.executable, os.path.abspath(__file__), *sys.argv[1:]],
        )
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
    if AS_ROOT and REQUIRE_ROOT and not _is_root():
        print(
            "AVISO: rodando como usuário comum; comandos usarão `sudo -n` se possível.",
            file=sys.stderr,
        )
    else:
        print(f"ai-shellplug rodando como {'root' if _is_root() else 'usuário'} "
              f"(euid={os.geteuid() if hasattr(os,'geteuid') else 'n/a'})", file=sys.stderr)
    if SESSION_USER_RESOLVED:
        print(f"comandos rodarão como usuário de sessão: {SESSION_USER_RESOLVED} "
              f"(home={_user_home(SESSION_USER_RESOLVED) or '?'})", file=sys.stderr)
    elif _is_root():
        print(
            "AVISO: rodando como root e nenhum usuário de sessão foi detectado; "
            "comandos rodarão como root. Defina AISHELLPLUG_SESSION_USER=<usuário>.",
            file=sys.stderr,
        )

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
