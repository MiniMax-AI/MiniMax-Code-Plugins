"""端到端冒烟测试：Python runner -> Rscript -> _common.R -> 各 mscripts/*.R。
先运行 prep_test.py 生成 tests/data/ 的三张 CSV，再依次跑 9 个工具。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from microbe_toolkit import runner  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(parents=True, exist_ok=True)
FT = str(DATA / "feature_table.csv")
TAX = str(DATA / "taxonomy.csv")
MD = str(DATA / "metadata.csv")


def show(tag, res):
    st = res["status"]
    if st == "ok":
        extra = f"outputs={res['n_outputs']}"
        for mtr in res.get("metrics", []):
            extra += f"\n      · {mtr}"
    elif st == "missing_packages":
        extra = f"missing={res['packages']}"
    else:
        extra = (res.get("error", "") + " | " + (res.get("log", "")[-500:]))
    print(f"[{st:16}] {tag:22} {extra}")


print("Rscript:", runner.find_rscript())
show("alpha", runner.run_script("alpha.R", {"feature_table": FT, "metadata": MD, "test": "wilcox"}, outdir=str(OUT)))
show("beta.pcoa", runner.run_script("beta.R", {"feature_table": FT, "metadata": MD, "method": "pcoa", "test": "both"}, outdir=str(OUT)))
show("beta.nmds", runner.run_script("beta.R", {"feature_table": FT, "metadata": MD, "method": "nmds"}, outdir=str(OUT / "nmds")))
show("composition.Phylum", runner.run_script("composition.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Phylum"}, outdir=str(OUT)))
show("composition.Genus", runner.run_script("composition.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "top_n": 12, "mode": "sample"}, outdir=str(OUT / "genus")))
show("diff.auto(deseq2)", runner.run_script("diff.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "group_test": "DSP", "group_ref": "DP"}, outdir=str(OUT)))
show("diff.edger", runner.run_script("diff.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "method": "edger", "group_test": "DSP", "group_ref": "DP", "kind": "volcano"}, outdir=str(OUT / "edger")))
show("network", runner.run_script("network.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "r_threshold": 0.7, "label": True}, outdir=str(OUT)))
show("rf", runner.run_script("rf.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "top_n": 15}, outdir=str(OUT)))
show("corr", runner.run_script("corr.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "variables": ["Leucine", "Isoleucine", "Valine", "Ustiloxin"]}, outdir=str(OUT)))
show("tree", runner.run_script("tree.R", {"feature_table": FT, "taxonomy": TAX, "metadata": MD, "level": "Genus", "layout": "circular"}, outdir=str(OUT)))
