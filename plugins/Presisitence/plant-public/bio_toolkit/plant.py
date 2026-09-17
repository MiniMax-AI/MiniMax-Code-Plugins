"""植物垂直资源模块。

分两类：
1) 有可编程接口的：Ensembl Plants REST（覆盖多种植物基因/序列，含茄科）。
2) 仅网页交互、无开放 API 的：SignalP / TMHMM / WoLF PSORT / PlantCARE / PlantTFDB /
   scPlantDB / SolGenomics / TAIR。
   对第 2 类提供结构化调度指引（提交步骤、输入格式、参数建议、结果解读），
   并标注可用 browser-use 浏览器自动化代为提交。

设计原则：绝不编造这些库的返回数据；无 API 者只给操作路径，由上层用浏览器或人工完成。
本发布包不含物种专库本地数据；茄科公共入口走 Sol Genomics / Ensembl Plants。
"""
from __future__ import annotations

from typing import Any

from .http import get_json

ENSEMBL_PLANTS = "https://rest.ensembl.org"

# 抗病研究常用物种 NCBI taxid（便于构造精确检索）
TAXIDS = {
    "solanum_lycopersicum": 4081,  # 番茄
    "solanum_tuberosum": 4113,     # 马铃薯
    "nicotiana_benthamiana": 4100, # 本氏烟
    "arabidopsis_thaliana": 3702,  # 拟南芥
    "oryza_sativa": 4530,          # 水稻
}

RESOURCES: dict[str, dict[str, Any]] = {
    "signalp6": {
        "name": "SignalP 6.0",
        "url": "https://services.healthtech.dtu.dk/services/SignalP-6.0/",
        "capability": "信号肽预测，判断是否分泌蛋白（效应子/PR 蛋白）",
        "access": "web-only",
        "input": "蛋白 FASTA（可批量，单次上限见网站）",
        "params": "Organism 选 Eukarya；Output 选 Long / summary",
        "interpret": "Sec/SPI 概率高且有 cleavage site 提示为分泌型；结合 TMHMM 排除跨膜假阳性",
        "automation": "browser-use 可上传 FASTA、提交并下载结果表",
    },
    "tmhmm2": {
        "name": "TMHMM 2.0",
        "url": "https://services.healthtech.dtu.dk/services/TMHMM-2.0/",
        "capability": "跨膜螺旋预测（受体类抗病蛋白 RLK/RLP 定位）",
        "access": "web-only",
        "input": "蛋白 FASTA",
        "params": "Output format 选 one line per protein 便于批量解析",
        "interpret": "PredHel>=1 表示含跨膜区；单跨膜+胞外 LRR 提示 RLK/RLP",
        "automation": "browser-use 可代为提交",
    },
    "wolfpsort": {
        "name": "WoLF PSORT",
        "url": "https://wolfpsort.hgc.jp/",
        "capability": "蛋白亚细胞定位预测",
        "access": "web-only",
        "input": "蛋白 FASTA",
        "params": "Organism type 选 Plant",
        "interpret": "输出各定位打分；抗病信号蛋白关注 nucl/cyto/plas 分布",
        "automation": "browser-use 可代为提交",
    },
    "interproscan_web": {
        "name": "InterProScan (网页版)",
        "url": "https://www.ebi.ac.uk/interpro/search/sequence/",
        "capability": "结构域/家族注释",
        "access": "api-available",
        "note": "本工具集已提供 REST 封装 (bio_toolkit.interpro)，优先用 API",
    },
    "plantcare": {
        "name": "PlantCARE",
        "url": "https://bioinformatics.psb.ugent.be/webtools/plantcare/html/",
        "capability": "启动子顺式作用元件分析（防御/胁迫元件 W-box、TC-rich、TCA 等）",
        "access": "web-only",
        "input": "启动子 DNA 序列（一般取 ATG 上游 1500-2000 bp）FASTA",
        "params": "提交 Search for CARE",
        "interpret": "关注防御相关元件：W-box(WRKY 结合)、TC-rich(防御/胁迫)、TCA(水杨酸)、"
                     "ABRE(ABA)、MYB/MYC(茉莉酸/干旱)",
        "automation": "browser-use 可粘贴序列提交并抓取元件表",
    },
    "planttfdb": {
        "name": "PlantTFDB",
        "url": "https://planttfdb.gao-lab.org/",
        "capability": "植物转录因子鉴定与家族分类（WRKY/MYB/bHLH/NAC 等）",
        "access": "web-only",
        "input": "蛋白序列（TF prediction）或直接按物种/家族浏览",
        "params": "TF Prediction 上传序列；或 Browse 选物种（如 Solanum lycopersicum）",
        "interpret": "返回 TF 家族归属；抗病常见 WRKY、MYB、NAC、ERF",
        "automation": "browser-use 可代为提交序列预测",
    },
    "solgenomics": {
        "name": "SolGenomics (SGN)",
        "url": "https://solgenomics.net/",
        "capability": "茄科基因组、注释、标记、BLAST（番茄、马铃薯、本氏烟等）",
        "access": "web-blast",
        "input": "核酸/蛋白序列做 BLAST，或按基因 ID 检索",
        "params": "选择目标基因组数据库（如 Solanum lycopersicum ITAG）",
        "interpret": "获取茄科同源基因位点与注释",
        "automation": "browser-use 可代为 BLAST；亦可用 NCBI 模块做等价检索",
    },
    "tair": {
        "name": "TAIR",
        "url": "https://www.arabidopsis.org/",
        "capability": "拟南芥基因/功能/突变体（抗病机制模式参考）",
        "access": "web-partial-login",
        "input": "AGI 基因 ID (如 AT1G64280=NPR1) 或基因名",
        "params": "部分内容需登录/配额",
        "interpret": "查抗病通路基因功能；机制参考可映射到作物同源基因",
        "automation": "程序化优先：BAR/ThaleMine 已封装为 REST 工具（bar_gene_function/bar_gene_info/bar_publications）；UniProt/NCBI 亦覆盖拟南芥",
    },
    "scplantdb": {
        "name": "scPlantDB",
        "url": "https://biobigdata.nju.edu.cn/scplantdb/marker",
        "capability": "植物单细胞图谱与 marker 基因（含番茄等）",
        "access": "web-only",
        "input": "物种 + 细胞类型 / marker 基因",
        "interpret": "获取细胞类型特异 marker，用于单细胞注释",
        "automation": "browser-use 可代为按物种(solanum_lycopersicum)检索 marker",
    },
    "colabfold": {
        "name": "ColabFold / AlphaFold2",
        "url": "https://colab.research.google.com/github/sokrypton/ColabFold/blob/main/AlphaFold2.ipynb",
        "capability": "从序列现算三维结构（AlphaFold DB 无收录时使用）",
        "access": "notebook",
        "input": "蛋白序列（单体或复合物用 : 分隔）",
        "params": "MSA mode: mmseqs2；num_recycles 视需要提高",
        "interpret": "pLDDT>70 较可信，>90 高可信；结合 PAE 判断域间相对定位",
        "note": "若 AlphaFold DB 已有该 UniProt 结构，优先用 structure.alphafold_summary 直接取",
    },
    "bar_efp": {
        "name": "BAR eFP Browser / ePlant",
        "url": "https://bar.utoronto.ca/",
        "capability": "拟南芥 eFP 表达（含 Biotic Stress 生物胁迫）数值与图像",
        "access": "api-available",
        "note": "已封装：bar_efp_views / bar_efp_expression / bar_efp_image（BAR REST API）",
    },
    "thalemine": {
        "name": "ThaleMine / Araport11 (InterMine, 经 BAR 代理)",
        "url": "https://bar.utoronto.ca/thalemine/",
        "capability": "拟南芥基因功能/GeneRIF/文献（抗病机制模式参考）",
        "access": "api-available",
        "note": "已封装：bar_gene_function / bar_publications / bar_gene_info",
    },
    "atted": {
        "name": "ATTED-II",
        "url": "https://atted.jp/",
        "capability": "拟南芥共表达网络（找共调控基因/候选上游 TF）",
        "access": "api-available",
        "note": "已封装：atted_coexpression（API v5）",
    },
    "string": {
        "name": "STRING",
        "url": "https://string-db.org/",
        "capability": "拟南芥(3702) 蛋白互作网络 + 功能富集",
        "access": "api-available",
        "note": "已封装：string_interactions / string_enrichment",
    },
}


def list_resources() -> list[dict[str, str]]:
    """列出全部植物垂直资源及访问方式，便于选择调度路径。"""
    return [
        {"key": k, "name": v["name"], "capability": v["capability"], "access": v["access"]}
        for k, v in RESOURCES.items()
    ]


def get_resource(key: str) -> dict[str, Any]:
    """获取某资源的详细调度指引（提交步骤/输入/参数/解读/自动化路径）。"""
    r = RESOURCES.get(key.lower())
    if not r:
        return {"error": f"未知资源 '{key}'", "available": list(RESOURCES.keys())}
    return {"key": key.lower(), **r}


def ensembl_lookup_symbol(species: str, symbol: str) -> dict[str, Any]:
    """按基因名在 Ensembl Plants 查基因。species 例: solanum_lycopersicum。"""
    url = f"{ENSEMBL_PLANTS}/lookup/symbol/{species}/{symbol}"
    return get_json(url, params={"content-type": "application/json", "expand": "1"})


def ensembl_sequence(ensembl_id: str, seq_type: str = "protein") -> str:
    """按 Ensembl ID 取序列。seq_type: protein / cds / genomic。"""
    from .http import get_text
    url = f"{ENSEMBL_PLANTS}/sequence/id/{ensembl_id}"
    return get_text(url, params={"type": seq_type}, accept="text/x-fasta")
