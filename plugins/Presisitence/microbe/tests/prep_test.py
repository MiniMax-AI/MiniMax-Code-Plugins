"""生成合成扩增子测试数据（stdlib-only，无需 numpy）到 tests/data/：
  feature_table.csv : feature_id + 12 样本计数 (DP1-6 病株, DSP1-6 抑病株)
  taxonomy.csv      : feature_id + Kingdom..Genus
  metadata.csv      : sample_name, group, group_name, TvsC, 代谢物列(Leucine/Isoleucine/Valine/Ustiloxin)

数据结构（刻意复刻两篇论文的信号，便于冒烟验证）：
  * L1 = 抑病轴：DSP≈+1 / DP≈-1。L1+ 类群富集于 DSP、L1- 富集于 DP（供 diff/rf/composition）。
  * L2/L3 = 与分组无关的共变模块（供 network 出现满足 |ρ|>0.7 的边）。
  * BCAA(Leucine/Isoleucine/Valine)=30+10*L1（DSP 高）；Ustiloxin=100-40*L1（DP 高，与 BCAA 负相关，复刻 Liu Fig2f）。
"""
import csv
import math
import random
from pathlib import Path

random.seed(42)
OUT = Path(__file__).resolve().parent / "data"
OUT.mkdir(parents=True, exist_ok=True)

# ---- 样本与潜变量 ----------------------------------------------------------
dp = [f"DP{i}" for i in range(1, 7)]
dsp = [f"DSP{i}" for i in range(1, 7)]
samples = dp + dsp
L1 = {s: (random.gauss(-1.0, 0.3) if s in dp else random.gauss(1.0, 0.3)) for s in samples}
L2 = {s: random.gauss(0, 1) for s in samples}
L3 = {s: random.gauss(0, 1) for s in samples}

# ---- 分类谱系 (Kingdom, Phylum, Class, Order, Family, Genus) ---------------
LINEAGES = [
    ("Bacteria", "Proteobacteria", "Gammaproteobacteria", "Pseudomonadales", "Pseudomonadaceae", "Pseudomonas"),
    ("Bacteria", "Proteobacteria", "Gammaproteobacteria", "Enterobacterales", "Enterobacteriaceae", "Enterobacter"),
    ("Bacteria", "Proteobacteria", "Gammaproteobacteria", "Xanthomonadales", "Xanthomonadaceae", "Stenotrophomonas"),
    ("Bacteria", "Proteobacteria", "Alphaproteobacteria", "Sphingomonadales", "Sphingomonadaceae", "Sphingomonas"),
    ("Bacteria", "Proteobacteria", "Alphaproteobacteria", "Rhizobiales", "Rhizobiaceae", "Rhizobium"),
    ("Bacteria", "Proteobacteria", "Alphaproteobacteria", "Rhizobiales", "Methylobacteriaceae", "Methylobacterium"),
    ("Bacteria", "Proteobacteria", "Betaproteobacteria", "Burkholderiales", "Comamonadaceae", "Variovorax"),
    ("Bacteria", "Proteobacteria", "Betaproteobacteria", "Burkholderiales", "Burkholderiaceae", "Ralstonia"),
    ("Bacteria", "Firmicutes", "Bacilli", "Lactobacillales", "Lactobacillaceae", "Lactobacillus"),
    ("Bacteria", "Firmicutes", "Bacilli", "Bacillales", "Bacillaceae", "Bacillus"),
    ("Bacteria", "Firmicutes", "Bacilli", "Bacillales", "Paenibacillaceae", "Paenibacillus"),
    ("Bacteria", "Firmicutes", "Clostridia", "Clostridiales", "Clostridiaceae", "Clostridium"),
    ("Bacteria", "Actinobacteria", "Actinomycetia", "Micrococcales", "Microbacteriaceae", "Curtobacterium"),
    ("Bacteria", "Actinobacteria", "Actinomycetia", "Micrococcales", "Microbacteriaceae", "Leifsonia"),
    ("Bacteria", "Actinobacteria", "Actinomycetia", "Streptomycetales", "Streptomycetaceae", "Streptomyces"),
    ("Bacteria", "Bacteroidetes", "Sphingobacteriia", "Sphingobacteriales", "Sphingobacteriaceae", "Pedobacter"),
    ("Bacteria", "Bacteroidetes", "Flavobacteriia", "Flavobacteriales", "Flavobacteriaceae", "Flavobacterium"),
    ("Bacteria", "Bacteroidetes", "Cytophagia", "Cytophagales", "Cytophagaceae", "Dyadobacter"),
    ("Fungi", "Ascomycota", "Eurotiomycetes", "Eurotiales", "Aspergillaceae", "Aspergillus"),
    ("Fungi", "Ascomycota", "Eurotiomycetes", "Eurotiales", "Aspergillaceae", "Penicillium"),
    ("Fungi", "Ascomycota", "Sordariomycetes", "Hypocreales", "Nectriaceae", "Fusarium"),
    ("Fungi", "Ascomycota", "Sordariomycetes", "Hypocreales", "Clavicipitaceae", "Ustilaginoidea"),
    ("Fungi", "Ascomycota", "Sordariomycetes", "Hypocreales", "Hypocreaceae", "Trichoderma"),
    ("Fungi", "Ascomycota", "Dothideomycetes", "Pleosporales", "Pleosporaceae", "Alternaria"),
    ("Fungi", "Ascomycota", "Dothideomycetes", "Capnodiales", "Cladosporiaceae", "Cladosporium"),
    ("Fungi", "Ascomycota", "Sordariomycetes", "Hypocreales", "Bionectriaceae", "Acremonium"),
    ("Fungi", "Basidiomycota", "Ustilaginomycetes", "Ustilaginales", "Ustilaginaceae", "Moesziomyces"),
    ("Fungi", "Basidiomycota", "Tremellomycetes", "Tremellales", "Trimorphomycetaceae", "Nigrospora"),
    ("Fungi", "Mortierellomycota", "Mortierellomycetes", "Mortierellales", "Mortierellaceae", "Mortierella"),
    ("Fungi", "Ascomycota", "Sordariomycetes", "Sordariales", "Chaetomiaceae", "Chaetomium"),
]

# 富集/共变模块指派：genus -> ("dsp"|"dp"|"m2"|"m3"|"none")
# 复刻论文：Lactobacillus/Aspergillus 等富集于抑病株；Ustilaginoidea/Fusarium 富集于病株。
MODULE = {
    "Lactobacillus": "dsp", "Aspergillus": "dsp", "Sphingomonas": "dsp", "Bacillus": "dsp",
    "Pseudomonas": "dsp", "Curtobacterium": "dsp", "Paenibacillus": "dsp", "Nigrospora": "dsp",
    "Ustilaginoidea": "dp", "Fusarium": "dp", "Ralstonia": "dp", "Alternaria": "dp",
    "Enterobacter": "dp", "Cladosporium": "dp",
    "Streptomyces": "m2", "Rhizobium": "m2", "Methylobacterium": "m2", "Variovorax": "m2",
    "Pedobacter": "m2", "Flavobacterium": "m2",
    "Trichoderma": "m3", "Penicillium": "m3", "Mortierella": "m3", "Chaetomium": "m3",
    "Acremonium": "m3", "Dyadobacter": "m3",
}

RANKS = ["Kingdom", "Phylum", "Class", "Order", "Family", "Genus"]
features = []   # (feature_id, lineage, module, base_mean, loading)
oid = 0
for lin in LINEAGES:
    genus = lin[5]
    mod = MODULE.get(genus, "none")
    n_otu = random.choice([2, 3, 4])
    for _ in range(n_otu):
        oid += 1
        base = math.exp(random.gauss(3.2, 1.1))     # 基础丰度
        load = random.uniform(0.7, 1.0)             # 模块载荷
        features.append((f"OTU{oid:03d}", lin, mod, base, load))


def scale(mod, load, s):
    if mod == "dsp":
        return math.exp(load * L1[s] + random.gauss(0, 0.25))
    if mod == "dp":
        return math.exp(-load * L1[s] + random.gauss(0, 0.25))
    if mod == "m2":
        return math.exp(load * L2[s] + random.gauss(0, 0.25))
    if mod == "m3":
        return math.exp(load * L3[s] + random.gauss(0, 0.25))
    return math.exp(random.gauss(0, 0.5))


# ---- 特征表 ----------------------------------------------------------------
with open(OUT / "feature_table.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["feature_id"] + samples)
    for fid, lin, mod, base, load in features:
        row = [fid]
        for s in samples:
            val = base * scale(mod, load, s)
            # 稀有类群偶发 0
            cnt = 0 if random.random() < 0.05 else int(round(val))
            row.append(cnt)
        w.writerow(row)

# ---- 分类表 ----------------------------------------------------------------
with open(OUT / "taxonomy.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["feature_id"] + RANKS)
    for fid, lin, mod, base, load in features:
        w.writerow([fid] + list(lin))

# ---- 元数据（含代谢物，复刻 BCAA 高于 DSP、Ustiloxin 高于 DP 且负相关）------
with open(OUT / "metadata.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["sample_name", "group", "group_name", "TvsC",
                "Leucine", "Isoleucine", "Valine", "Ustiloxin"])
    for s in samples:
        tvsc = "treatment" if s in dsp else "control"
        leu = 30 + 10 * L1[s] + random.gauss(0, 1.5)
        ile = 18 + 6 * L1[s] + random.gauss(0, 1.2)
        val = 22 + 7 * L1[s] + random.gauss(0, 1.2)
        ust = max(0.0, 100 - 40 * L1[s] + random.gauss(0, 6))
        w.writerow([s, s[:-1] if s[-1].isdigit() else s,
                    "DSP" if s in dsp else "DP", tvsc,
                    round(leu, 2), round(ile, 2), round(val, 2), round(ust, 2)])

print(f"OK: {len(features)} OTUs x {len(samples)} samples -> {OUT}")
print("  feature_table.csv / taxonomy.csv / metadata.csv")
