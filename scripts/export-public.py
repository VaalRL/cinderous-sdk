"""公開 repo 的發版匯出（SDK ADR 0110）：把 dev repo 的匯出（LF）套上公開版的調整，放進公開 repo 的工作區。

用法：python -X utf8 scripts/export-public.py <新匯出> <上一版匯出> <公開 repo 工作區>

完整流程（以 v0.77.0 為例；「上一版」是公開 repo HEAD 對應的 dev repo commit）：
  1. git -c core.autocrlf=false -c core.eol=lf archive v0.77.0 | tar -x -C <新匯出>
     上一版同樣匯出到 <上一版匯出>。
  2. 跑本腳本。上一版匯出與公開 repo HEAD 之間的改寫（連結改純文字等），逐段套到新匯出上；
     每段舊文字必須剛好出現一次，否則中止——代表 dev repo 改到了那一段，要手動看。
  3. 在公開工作區 npm ci、npx tsc --noEmit、npx vitest run。
  4. commit「Cinderous SDK vX.Y.Z」、打 tag、push（push 前要使用者同意）。
"""
import difflib
import json
import pathlib
import shutil
import subprocess
import sys

new, prev, pub = (pathlib.Path(a) for a in sys.argv[1:4])
# 不公開的檔案（ADR 0110 第 6 項）；說明網站也用同一份（SDK ADR 0113）
EXCLUDE = json.loads((pathlib.Path(__file__).parent / "public-exclude.json").read_text(encoding="utf-8"))
# 公開版有改寫的檔案（連到上面那些檔案的連結）
REWRITTEN = ["PRD.md", "README.md", "README.zh-TW.md"]


def pub_head(rel):
    out = subprocess.run(["git", "-c", "core.autocrlf=false", "show", f"HEAD:{rel}"], cwd=pub, capture_output=True, check=True)
    return out.stdout.decode("utf-8")


rewritten = {}
for rel in REWRITTEN:
    a = (prev / rel).read_text(encoding="utf-8").split("\n")
    b = pub_head(rel).split("\n")
    target = (new / rel).read_text(encoding="utf-8")
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        old = "\n".join(a[i1:i2]) + "\n"
        repl = "\n".join(b[j1:j2]) + "\n" if j2 > j1 else ""
        assert i2 > i1, (rel, "pure insert", b[j1:j2])
        assert target.count(old) == 1, (rel, old[:100], target.count(old))
        target = target.replace(old, repl)
    rewritten[rel] = target

# 清掉公開工作區的追蹤檔（保留 .git 與 node_modules），再複製新匯出
for item in pub.iterdir():
    if item.name in (".git", "node_modules"):
        continue
    shutil.rmtree(item) if item.is_dir() else item.unlink()
for item in new.iterdir():
    dest = pub / item.name
    shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)
for rel in EXCLUDE:
    p = pub / rel
    if p.is_dir():
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()
for rel, text in rewritten.items():
    with open(pub / rel, "w", encoding="utf-8", newline="") as f:
        f.write(text)
print("ok")
