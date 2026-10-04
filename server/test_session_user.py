#!/usr/bin/env python3
"""Testes unitários da seleção de usuário de sessão e do wrapper de execução.

Não sobem servidor: importam `server.py` como módulo e verificam a lógica de
argv/script/sessão, com as partes de root/usuário-alvo simuladas (monkeypatch).
"""
import os
import sys
import importlib
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".venv", "lib"))


def fresh(**env):
    """Recarrega server.py com variáveis de ambiente específicas.

    Isola o fallback de senha (`$TMPDIR/aisp.pw`) apontando TMPDIR para um dir
    temporário vazio, para que os testes não herdem a senha do ambiente real.
    """
    saved = dict(os.environ)
    os.environ.update({k: str(v) for k, v in env.items()})
    os.environ.pop("AISHELLPLUG_SUDO_PASSWORD", None)
    _tmp = tempfile.mkdtemp(prefix="aisp_test_")
    os.environ["TMPDIR"] = _tmp
    tempfile.tempdir = None  # força reavaliação de tempfile.gettempdir()
    try:
        for m in ("server",):
            sys.modules.pop(m, None)
        return importlib.import_module("server")
    finally:
        os.environ.clear()
        os.environ.update(saved)
        tempfile.tempdir = None


class BuildScript(unittest.TestCase):
    def test_script_leva_cmd_e_sentinel(self):
        s = fresh()
        out = s._build_script("echo oi", "/tmp/sentinel")
        self.assertIn("echo oi", out)
        self.assertIn("pwd > /tmp/sentinel", out)
        self.assertIn("env >> /tmp/sentinel", out)
        self.assertIn("exit $__aisp_code", out)

    def test_heredoc_preservado_no_script(self):
        """O cmd vai literal no script; nada é reescrito/quebrado por linha."""
        s = fresh()
        cmd = "cat > /tmp/x.sh <<'EOF'\necho a\necho b\nEOF"
        out = s._build_script(cmd, "/tmp/sentinel")
        self.assertIn(cmd, out)  # herdoc intacto
        self.assertTrue(out.startswith(cmd + "\n"))

    def test_windows_usa_powershell(self):
        s = fresh()
        s.IS_WINDOWS = True
        out = s._build_script("Write-Host oi", "C:/tmp/s.txt")
        self.assertIn("Out-File", out)
        self.assertIn("Get-Location", out)


class BuildArgv(unittest.TestCase):
    def test_sem_root_sem_user(self):
        s = fresh(AISHELLPLUG_AS_ROOT="0", AISHELLPLUG_REQUIRE_ROOT="0")
        s._is_root = lambda: False
        argv = s._build_argv("")
        self.assertEqual(argv, ["bash", "-c", "bash"])  # script vem por stdin

    def test_root_com_usuario_usa_sudo_sem_senha(self):
        s = fresh()
        s._is_root = lambda: True
        s.SUDO_PASSWORD = ""
        argv = s._build_argv("junior")
        # Já somos root: `sudo -u` não pede senha e NÃO pode usar -S (a senha
        # vazaria para a shell interna). Também não pode usar -i (descarta stdin)
        # nem -l (roda rc de login do alvo, poluindo o stderr de toda execução).
        self.assertEqual(argv, ["sudo", "-H", "-u", "junior", "bash"])
        self.assertNotIn("-S", argv)
        self.assertNotIn("-i", argv)

    def test_root_com_usuario_e_senha_ainda_sem_sudo_S(self):
        s = fresh()
        s._is_root = lambda: True
        s.SUDO_PASSWORD = "jazz3023"
        argv = s._build_argv("junior")
        # Mesmo com senha configurada, sendo root não usamos -S nem expomos a senha.
        self.assertEqual(argv, ["sudo", "-H", "-u", "junior", "bash"])
        self.assertNotIn("-S", argv)
        self.assertNotIn("jazz3023", argv)

    def test_root_sem_usuario_roda_como_root(self):
        s = fresh()
        s._is_root = lambda: True
        argv = s._build_argv("")
        self.assertEqual(argv, ["bash", "-c", "bash"])

    def test_usuario_ignorado_se_nao_root_com_as_root_on(self):
        """Sem privilégio, 'sudo -u' não é possível: cai em `sudo -n` (AS_ROOT on)."""
        s = fresh(AISHELLPLUG_AS_ROOT="1", AISHELLPLUG_REQUIRE_ROOT="1")
        s._is_root = lambda: False
        argv = s._build_argv("junior")
        self.assertEqual(argv, ["sudo", "-n", "bash", "-c", "bash"])

    def test_usuario_ignorado_se_nao_root_com_as_root_off(self):
        """Sem privilégio e sem auto-elevação: shell normal."""
        s = fresh(AISHELLPLUG_AS_ROOT="0", AISHELLPLUG_REQUIRE_ROOT="0")
        s._is_root = lambda: False
        argv = s._build_argv("junior")
        self.assertEqual(argv, ["bash", "-c", "bash"])

    def test_as_root_nao_root_prefixa_sudo_n(self):
        s = fresh(AISHELLPLUG_AS_ROOT="1", AISHELLPLUG_REQUIRE_ROOT="1")
        s._is_root = lambda: False
        argv = s._build_argv("")
        self.assertEqual(argv, ["sudo", "-n", "bash", "-c", "bash"])


class Askpass(unittest.TestCase):
    """O helper SUDO_ASKPASS permite `sudo` digitado pelo usuário (sem TTY)."""

    def test_script_injeta_path_e_askpass(self):
        s = fresh()
        bindir = tempfile.mkdtemp(prefix="aisp_bin_")
        out = s._build_script("sudo id", "/tmp/sent", {}, "", askpass_bin=bindir)
        self.assertIn(f"export PATH={bindir}:", out)
        self.assertIn("export SUDO_ASKPASS=", out)
        self.assertTrue(out.index("export PATH") < out.index("sudo id"))

    def test_sem_askpass_bin_nao_exporta_askpass(self):
        s = fresh()
        out = s._build_script("echo oi", "/tmp/sent")
        self.assertNotIn("SUDO_ASKPASS", out)

    def test_ensure_askpass_cria_helper_e_wrapper(self):
        import shutil

        s = fresh()
        s.SUDO_PASSWORD = "s3cr3t-xyz"
        s._ASKPASS_DIR = __import__("pathlib").Path(
            tempfile.mkdtemp(prefix="aisp_dir_")
        )
        try:
            bindir = s._ensure_askpass(
                # usa o próprio usuário atual para permitir os.chown
                __import__("getpass").getuser()
            )
            self.assertTrue(bindir)
            helper = s._ASKPASS_DIR / "askpass.sh"
            wrapper = __import__("pathlib").Path(bindir) / "sudo"
            self.assertTrue(helper.is_file())
            self.assertTrue(wrapper.is_file())
            self.assertIn("s3cr3t-xyz", (s._ASKPASS_DIR / "pw").read_text())
            self.assertIn("cat ", helper.read_text())
            self.assertIn("-A", wrapper.read_text())
        finally:
            shutil.rmtree(s._ASKPASS_DIR, ignore_errors=True)

    def test_ensure_askpass_sem_senha_retorna_vazio(self):
        s = fresh()
        s.SUDO_PASSWORD = ""
        self.assertEqual(s._ensure_askpass("junior"), "")
        self.assertEqual(s._ensure_askpass(""), "")


class ResolveSessionUser(unittest.TestCase):
    def test_explicito_tem_prioridade(self):
        s = fresh(AISHELLPLUG_SESSION_USER="alice")
        s._is_root = lambda: True
        s.SESSION_USER = "alice"
        self.assertEqual(s._resolve_session_user(), "alice")

    def test_sudo_user_quando_root(self):
        s = fresh()
        s._is_root = lambda: True
        s.SESSION_USER = ""
        os.environ["SUDO_USER"] = "bob"
        try:
            self.assertEqual(s._resolve_session_user(), "bob")
        finally:
            os.environ.pop("SUDO_USER", None)

    def test_nao_root_nao_troca(self):
        s = fresh()
        s._is_root = lambda: False
        s.SESSION_USER = ""
        self.assertEqual(s._resolve_session_user(), "")


class SessionCwd(unittest.TestCase):
    def test_cwd_inicial_e_home_do_usuario(self):
        s = fresh()
        s.SESSION_USER_RESOLVED = "junior"
        s._user_home = lambda u: "/home/junior"
        s._sessions = {}
        sess = s._session("teste1")
        self.assertEqual(sess["cwd"], "/home/junior")

    def test_cwd_fallback_quando_home_nao_existe(self):
        s = fresh()
        s.SESSION_USER_RESOLVED = ""
        s._sessions = {}
        sess = s._session("teste2")
        self.assertEqual(sess["cwd"], os.getcwd())


if __name__ == "__main__":
    unittest.main(verbosity=2)
