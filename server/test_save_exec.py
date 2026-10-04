"""Testa que _save_exec grava cmd+stdout+stderr ÍNTEGROS (sem truncar)."""
import json, os, sys
from pathlib import Path
os.environ["AISHELLPLUG_SAVE_EXECS"] = "1"
os.environ["AISHELLPLUG_REQUIRE_ROOT"] = "0"
sys.path.insert(0, str(Path(__file__).parent))
import server as srv  # noqa

ok = 0; fail = 0
def check(n, c):
    global ok, fail
    if c: ok += 1; print("PASS", n)
    else: fail += 1; print("FAIL", n)

# stdout grande (não pode truncar) + stderr + cmd multi-linha
stdout = "\n".join(f"linha_{i} açentuação" for i in range(1500))
name = srv._save_exec({"rid":"t1","sid":"s","cmd":"echo a;\necho b","cwd":"/tmp",
                       "user":"root","exit":0,"duration_ms":5,"stdout":stdout,"stderr":"ERRO\n"})
check("gravou arquivo", bool(name) and (srv.EXEC_DIR/name).exists())
rec = json.loads((srv.EXEC_DIR/name).read_text(encoding="utf-8"))
check("cmd íntegro multi-linha", rec["cmd"] == "echo a;\necho b")
check("stdout íntegro (sem truncar)", rec["stdout"] == stdout and rec["stdout"].count("linha_")==1500)
check("stderr íntegro", rec["stderr"] == "ERRO\n")
check("metadados", rec["exit"]==0 and rec["user"]=="root")

# desligado
srv.SAVE_EXECS = False
check("respeita SAVE_EXECS=0", srv._save_exec({"cmd":"x"}) == "")
srv.SAVE_EXECS = True
print("\nSAVE-EXEC", "OK" if not fail else "FALHOU")
sys.exit(1 if fail else 0)
