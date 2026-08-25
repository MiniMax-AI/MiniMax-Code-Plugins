"""microbe —— 下游微生物组/扩增子(16S·ITS) 分析 MCP Server (FastMCP)。

把一套清洗、参数化的微生物组分析 R 脚本（mscripts/*.R；vegan/DESeq2/edgeR/igraph/Hmisc/
randomForest/ggtree/ggplot2）暴露为 MCP 工具，由本机 Rscript 引擎渲染，产出出版级 png+pdf。
定位不到 R 时返回可手动运行的脚本与命令；R 端缺包时返回缺失包名与安装建议。

工具映射两篇经典微生物组论文的核心图：
  Liu 2023 (Nat Microbiol, 稻曲病叶际菌群) 与 Zhou 2022 (Nat Commun, 番茄枯萎病跨界合成菌群)。

数据契约（3 张 CSV）：
  feature_table.csv : feature_id + 各样本计数列（OTU/ASV/属丰度表）
  taxonomy.csv      : feature_id + 界门纲目科属种(分列) 或 单列 QIIME 分号串(k__;p__;...)
  metadata.csv      : sample_name + group[/group_name][/TvsC][+ 环境/代谢物数值列]

运行:
    uv run --directory <this-dir> server.py
"""
from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from microbe_toolkit import runner

mcp = FastMCP("microbe")


def _clean(**kw: Any) -> dict[str, Any]:
    """丢弃值为 None 的参数，避免污染 R 端 params。"""
    return {k: v for k, v in kw.items() if v is not None}


def _run(script: str, params: dict[str, Any], outdir: str) -> dict[str, Any]:
    return runner.run_script(script, params, outdir=outdir)


# ============================ 环境自检 ============================
@mcp.tool()
def microbe_env() -> dict[str, Any]:
    """检查 R 引擎与关键微生物组分析包是否就绪（首次使用/报错排查先跑这个）。返回 Rscript
    路径、各包安装状态与缺包安装建议（区分 CRAN / Bioconductor）。"""
    rscript = runner.find_rscript()
    pkgs = [
        "vegan", "ggplot2", "ggpubr", "dplyr", "tidyr", "reshape2", "pheatmap", "ggrepel",
        "scales", "igraph", "Hmisc", "randomForest", "ape", "circlize", "ggalluvial",
        "edgeR", "DESeq2", "ggtree", "phyloseq", "SpiecEasi",
    ]
    status = runner.check_packages(pkgs, rscript=rscript) if rscript else {p: False for p in pkgs}
    missing = [p for p, ok in status.items() if not ok]
    return {
        "rscript": rscript or "未找到 (请设置环境变量 MICROBE_RSCRIPT 指向 Rscript.exe)",
        "mscripts_dir": str(runner.mscripts_dir()),
        "packages": status,
        "missing": missing,
        "install_hint": runner._install_hint(missing) if missing else "",
    }


# ============================ α 多样性 ============================
@mcp.tool()
def microbe_alpha(feature_table: str, metadata: str, outdir: str,
                  metrics: list[str] | None = None, test: str = "wilcox",
                  rarefy: bool = False, depth: int | None = None,
                  pairwise: bool = True, dpi: int = 300) -> dict[str, Any]:
    """α多样性指数箱线图 + 组间检验（Liu2023 Fig1a,b,d,e / Zhou2022 Fig1e,f）。
    metrics 可选 Observed/Chao1/ACE/Shannon/Simpson/InvSimpson/Pielou(默认前四)。
    test: wilcox(默认)/t.test/anova/kruskal；rarefy=True 先抽平(depth 缺省取最小样本深度)。
    产出 alpha_diversity.csv(各样本指数) + alpha_boxplot.png/pdf。需 vegan(已装)；
    显著性标注需 ggpubr(已装)。"""
    return _run("alpha.R", _clean(feature_table=feature_table, metadata=metadata, metrics=metrics,
                                  test=test, rarefy=rarefy, depth=depth, pairwise=pairwise,
                                  dpi=dpi), outdir)


# ============================ β 多样性 ============================
@mcp.tool()
def microbe_beta(feature_table: str, metadata: str, outdir: str, method: str = "pcoa",
                 distance: str = "bray", test: str = "permanova", permutations: int = 999,
                 relabund: bool = True, ellipse: bool = True, label: bool = False,
                 dpi: int = 300) -> dict[str, Any]:
    """β多样性排序 (PCoA/NMDS) + 组间差异检验（Liu2023 Fig1c,f / Zhou2022 Fig1c,d）。
    method: pcoa(默认)/nmds；distance: bray(默认)/jaccard/euclidean；
    test: permanova(adonis2,默认)/anosim/both；relabund=True 先转相对丰度；ellipse 加 95% 椭圆。
    产出 beta_scores.csv、beta_stats.csv(R2/P)、beta_<method>.png/pdf(副标题含 PERMANOVA R2/P)。需 vegan。"""
    return _run("beta.R", _clean(feature_table=feature_table, metadata=metadata, method=method,
                                 distance=distance, test=test, permutations=permutations,
                                 relabund=relabund, ellipse=ellipse, label=label, dpi=dpi), outdir)


# ============================ 物种组成 ============================
@mcp.tool()
def microbe_composition(feature_table: str, taxonomy: str, metadata: str, outdir: str,
                        level: str = "Phylum", top_n: int = 10, mode: str = "group",
                        dpi: int = 300) -> dict[str, Any]:
    """物种组成堆叠柱状图（Liu2023 Fig1g / Zhou2022 Fig4k,l, Fig5）。
    level: Phylum(默认)/Class/Order/Family/Genus/Species；top_n 其余合并为 Others；
    mode: group(组内均值,默认)/sample(逐样本)。产出 composition_<level>.csv(相对丰度表) +
    composition_<level>.png/pdf。taxonomy 支持分列或 QIIME 分号串。"""
    return _run("composition.R", _clean(feature_table=feature_table, taxonomy=taxonomy,
                                        metadata=metadata, level=level, top_n=top_n, mode=mode,
                                        dpi=dpi), outdir)


# ============================ 差异丰度 ============================
@mcp.tool()
def microbe_diff(feature_table: str, metadata: str, outdir: str, taxonomy: str | None = None,
                 level: str | None = None, method: str = "auto",
                 group_test: str | None = None, group_ref: str | None = None,
                 padj: float = 0.05, log2fc: float = 1.0, min_count: float = 1.0,
                 min_prev: int = 2, kind: str = "bar", top_n: int = 30,
                 dpi: int = 300) -> dict[str, Any]:
    """差异丰度分析（Liu2023 Fig3a,b DESeq2 / Zhou2022 EdgeR）。
    method: auto(有 DESeq2 用 deseq2 否则 edger,默认)/deseq2/edger/wilcox。
    给 taxonomy+level(如 Genus) 则按该层级汇总后做差异，否则按 feature。
    两组来源: group_test/group_ref → metadata 的 TvsC(treatment/control) → 前两组。
    kind: bar(显著类群 log2FC 条形,按富集组着色,默认)/volcano。产出 diff_result.csv + diff_<kind>.png/pdf。
    注: DESeq2 用 poscounts 处理微生物组多零；本机已装 DESeq2/edgeR。"""
    return _run("diff.R", _clean(feature_table=feature_table, metadata=metadata, taxonomy=taxonomy,
                                 level=level, method=method, group_test=group_test,
                                 group_ref=group_ref, padj=padj, log2fc=log2fc,
                                 min_count=min_count, min_prev=min_prev, kind=kind, top_n=top_n,
                                 dpi=dpi), outdir)


# ============================ 共现网络 ============================
@mcp.tool()
def microbe_network(feature_table: str, outdir: str, metadata: str | None = None,
                    taxonomy: str | None = None, level: str | None = None,
                    group: str | None = None, method: str = "spearman",
                    r_threshold: float = 0.7, p_threshold: float = 0.05, padjust: bool = True,
                    min_prev: int | None = None, top_n: int = 150, layout: str = "fr",
                    label: bool = False, dpi: int = 300) -> dict[str, Any]:
    """微生物共现网络（Liu2023 Fig1i / Zhou2022 Fig2a-f）。Hmisc::rcorr 算 Spearman ρ，
    |r|>=r_threshold(0.7) 且 P<p_threshold(0.05, 默认 BH 校正) 保留边；igraph 算模块度/度/
    正负边占比/平均路径长度，并按 度+接近中心性 标出 keystone 枢纽菌。
    group 指定则只用该组样本建网；level 指定则先按分类层级汇总。layout: fr(默认)/circle。
    产出 network_edges.csv、network_nodes.csv(含 module/degree/keystone)、network_topology.csv、
    network.png/pdf(正边红/负边蓝,点大小=degree,按模块着色)。需 Hmisc+igraph(已装)。"""
    return _run("network.R", _clean(feature_table=feature_table, metadata=metadata,
                                    taxonomy=taxonomy, level=level, group=group, method=method,
                                    r_threshold=r_threshold, p_threshold=p_threshold,
                                    padjust=padjust, min_prev=min_prev, top_n=top_n,
                                    layout=layout, label=label, dpi=dpi), outdir)


# ============================ 随机森林 biomarker ============================
@mcp.tool()
def microbe_rf(feature_table: str, metadata: str, outdir: str, taxonomy: str | None = None,
               level: str | None = None, top_n: int = 20, ntree: int = 1000,
               cv: bool = True, cv_fold: int = 10, seed: int = 123,
               dpi: int = 300) -> dict[str, Any]:
    """随机森林分类 biomarker + 十折交叉验证误差曲线（Zhou2022 Fig2g-j）。
    以相对丰度训练 randomForest，输出 MeanDecreaseGini 重要性(按富集组着色)与 OOB 误差；
    cv=True 做 rfcv 十折交叉验证并画误差-特征数曲线以定最优 biomarker 数。
    给 taxonomy+level(如 Genus) 则按该层级建模，否则按 feature。产出 rf_importance.csv/png/pdf、
    rf_cv.csv、rf_cv_error.png/pdf。需 randomForest(已装)。"""
    return _run("rf.R", _clean(feature_table=feature_table, metadata=metadata, taxonomy=taxonomy,
                               level=level, top_n=top_n, ntree=ntree, cv=cv, cv_fold=cv_fold,
                               seed=seed, dpi=dpi), outdir)


# ============================ 微生物-代谢物/环境 相关热图 ============================
@mcp.tool()
def microbe_corr(feature_table: str, metadata: str, outdir: str, taxonomy: str | None = None,
                 level: str | None = None, variables: list[str] | None = None,
                 features: list[str] | None = None, method: str = "spearman", top_n: int = 30,
                 padjust: bool = True, star: bool = True, dpi: int = 300) -> dict[str, Any]:
    """微生物-代谢物/环境因子 相关热图（Liu2023 Fig2f: 丰度与氨基酸/毒素相关, r + P）。
    variables: metadata 中的数值列名向量(代谢物/环境因子；缺省自动取除分组外的数值列)；
    features: 限定微生物类群(缺省取最丰 top_n)。method: spearman(默认)/pearson；
    star=True 叠加显著性星号(*<0.05 **<0.01 ***<0.001，默认 BH 校正)。
    产出 corr_r.csv、corr_p.csv、corr_heatmap.png/pdf(蓝-白-红填 r)。需 Hmisc(已装)。"""
    return _run("corr.R", _clean(feature_table=feature_table, metadata=metadata, taxonomy=taxonomy,
                                 level=level, variables=variables, features=features, method=method,
                                 top_n=top_n, padjust=padjust, star=star, dpi=dpi), outdir)


# ============================ 分类树/发育树 + 丰度环 ============================
@mcp.tool()
def microbe_tree(feature_table: str, taxonomy: str, metadata: str, outdir: str,
                 level: str = "Genus", color_by: str = "Phylum", layout: str = "circular",
                 ring: bool = True, top_n: int = 60, dpi: int = 300) -> dict[str, Any]:
    """分类树/系统发育树 + 组均值丰度环（Zhou2022 Fig3a,b）。无测序数据时以分类学层级
    (ape::as.phylo formula)构树；失败自动退化为按丰度谱(1-Pearson)聚类构树。
    level: 树尖层级(默认 Genus)；color_by: 树尖着色的分类等级(默认 Phylum)；
    layout: circular(默认)/fan/rectangular；ring=True 加组均值相对丰度热环。
    产出 tree_tip_abundance.csv + tree.png/pdf。需 ape+ggtree(已装)。"""
    return _run("tree.R", _clean(feature_table=feature_table, taxonomy=taxonomy, metadata=metadata,
                                 level=level, color_by=color_by, layout=layout, ring=ring,
                                 top_n=top_n, dpi=dpi), outdir)


if __name__ == "__main__":
    mcp.run()
