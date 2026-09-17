"""rnaseq-plot —— RNA-seq 下游出图 MCP Server (FastMCP)。

把一套清洗过、参数化的 R 出图脚本（rscripts/*.R）暴露为 MCP 工具，由本机 Rscript 引擎渲染，
产出 png+pdf。工具函数名保持 `rgraph_*`，与既有客户端配置兼容。

定位不到 R 时返回可手动运行的脚本与命令；R 端缺包时返回缺失包名与安装建议。

运行:
    uv run --directory <this-dir> server.py
"""
from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from rgraph_toolkit import runner

mcp = FastMCP("rnaseq-plot")


def _clean(**kw: Any) -> dict[str, Any]:
    """丢弃值为 None 的参数，避免污染 R 端 params。"""
    return {k: v for k, v in kw.items() if v is not None}


def _run(script: str, params: dict[str, Any], outdir: str) -> dict[str, Any]:
    return runner.run_script(script, params, outdir=outdir)


# ============================ 环境自检 ============================
@mcp.tool()
def rgraph_env() -> dict[str, Any]:
    """检查 R 引擎与关键 R 包是否就绪（首次使用/报错排查先跑这个）。返回 Rscript 路径、
    各包安装状态与缺包安装建议。"""
    rscript = runner.find_rscript()
    pkgs = [
        "ggplot2", "dplyr", "tidyr", "stringr", "pheatmap", "ggrepel", "reshape2",
        "DESeq2", "edgeR", "limma", "clusterProfiler", "enrichplot", "pathview",
        "circlize", "ComplexHeatmap", "WGCNA", "VennDiagram", "GSVA", "GSEABase", "fgsea",
        "ggpubr", "patchwork", "ggridges", "ggbreak", "ggalluvial", "plotly", "factoextra",
        "igraph", "ggraph", "tidygraph", "ggforce", "ggNetView", "GENIE3",
    ]
    status = runner.check_packages(pkgs, rscript=rscript) if rscript else {p: False for p in pkgs}
    missing = [p for p, ok in status.items() if not ok]
    return {
        "rscript": rscript or "未找到 (请设置环境变量 RGRAPH_RSCRIPT 指向 Rscript.exe)",
        "rscripts_dir": str(runner.rscripts_dir()),
        "packages": status,
        "missing": missing,
        "install_hint": runner._install_hint(missing) if missing else "",
    }


# ============================ 01 表达量归一化 ============================
@mcp.tool()
def rgraph_normalize(count: str, outdir: str, method: str = "fpkm",
                     sample_group: str | None = None) -> dict[str, Any]:
    """由 count 计算 FPKM/TPM。count 为 gene_count.csv(列: gene_id,Length,<各样本>)。
    method: fpkm/tpm。sample_group 可选(限定样本列)。产出 gene_fpkm.csv 或 gene_tpm.csv。"""
    return _run("normalize.R", _clean(count=count, method=method, sample_group=sample_group), outdir)


# ============================ 02 相关性 / PCA ============================
@mcp.tool()
def rgraph_correlation(fpkm: str, sample_group: str, outdir: str,
                       dpi: int = 300, width: float = 6, height: float = 6) -> dict[str, Any]:
    """样本间 Pearson 相关性热图(基于 log2(fpkm+1))。fpkm: gene_fpkm.csv；sample_group 含 sample_name。"""
    return _run("correlation_heatmap.R",
                _clean(fpkm=fpkm, sample_group=sample_group, dpi=dpi, width=width, height=height), outdir)


@mcp.tool()
def rgraph_pca(fpkm: str, sample_group: str, outdir: str, ellipse: bool = False,
               label: bool = True, palette: str = "course", dpi: int = 300) -> dict[str, Any]:
    """样本 PCA 散点图(log2(fpkm+1)+prcomp)。ellipse: 加 95% 置信椭圆；label: ggrepel 样本标签；
    palette: course/colorblind。sample_group 需含 group_name。"""
    return _run("pca.R", _clean(fpkm=fpkm, sample_group=sample_group, ellipse=ellipse,
                                label=label, palette=palette, dpi=dpi), outdir)


# ============================ 03 表达分布 ============================
@mcp.tool()
def rgraph_distribution(fpkm: str, sample_group: str, outdir: str, kind: str = "box",
                        palette: str = "course", dpi: int = 300) -> dict[str, Any]:
    """表达分布图。kind: box(箱线)/violin(小提琴)/density(密度)。按 group_name 着色。"""
    return _run("distribution.R", _clean(fpkm=fpkm, sample_group=sample_group, kind=kind,
                                         palette=palette, dpi=dpi), outdir)


# ============================ 04 差异分析 ============================
@mcp.tool()
def rgraph_diff(count: str, sample_group: str, outdir: str, method: str = "deseq2",
                sig_metric: str = "padj", pcut: float = 0.05, log2fc: float = 1.0,
                min_mean_count: float = 1.0) -> dict[str, Any]:
    """差异表达分析。method: deseq2/edger/edger_norep(无生物学重复)/limma。
    sig_metric: padj(推荐,默认)/pvalue；pcut、log2fc 为阈值。分组由 sample_group 的 TvsC 列
    (treatment/control)决定。产出 01.Dse2_result.csv 及 Deg_all/up/down。
    注：DESeq2 需已安装(本机默认缺,可改 method=edger/limma 或按提示安装)。"""
    return _run("diff.R", _clean(count=count, sample_group=sample_group, method=method,
                                 sig_metric=sig_metric, pcut=pcut, log2fc=log2fc,
                                 min_mean_count=min_mean_count), outdir)


@mcp.tool()
def rgraph_volcano(result: str, outdir: str, sig_metric: str = "padj", pcut: float = 0.05,
                   log2fc: float = 1.0, color_scheme: str = "rb", label_n: int = 0,
                   genes: list[str] | None = None) -> dict[str, Any]:
    """火山图。result 为差异结果表(含 gene_id,log2FoldChange,pvalue,padj)。
    color_scheme: rb(色盲友好红蓝,默认)/rg(课程红绿)；label_n: 标注显著性最高的前 N 个；
    genes: 自定义标注基因清单(优先于 label_n)。"""
    return _run("volcano.R", _clean(result=result, sig_metric=sig_metric, pcut=pcut, log2fc=log2fc,
                                    color_scheme=color_scheme, label_n=label_n, genes=genes), outdir)


@mcp.tool()
def rgraph_heatmap(fpkm: str, sample_group: str, outdir: str, deg: str | None = None,
                   genes: list[str] | None = None, engine: str = "pheatmap",
                   scale: str = "row", cluster_cols: bool = True,
                   show_rownames: bool | None = None) -> dict[str, Any]:
    """差异/指定基因表达聚类热图(log2(fpkm+1))。基因来源: genes 优先，其次 deg(Deg_all.csv)，
    否则全部。engine: pheatmap(默认) 或 complexheatmap(按 group_name 加顶部分组色块、列不聚类)。"""
    return _run("heatmap.R", _clean(fpkm=fpkm, sample_group=sample_group, deg=deg, genes=genes,
                                    engine=engine, scale=scale, cluster_cols=cluster_cols,
                                    show_rownames=show_rownames), outdir)


# ============================ 05 富集分析 (GO/KEGG) ============================
@mcp.tool()
def rgraph_enrich(gene_list: str, outdir: str, type: str = "go", orgdb: str = "org.Hs.eg.db",
                  id_type: str = "ENSEMBL", ont: str = "all", go_source: str = "orgdb",
                  kegg_source: str = "online", kegg_species: str = "hsa",
                  gmt: str | None = None, kegg_info: str | None = None,
                  pvalueCutoff: float = 1.0, qvalueCutoff: float = 1.0) -> dict[str, Any]:
    """GO/KEGG 富集分析。gene_list 为含 gene_id 列的 CSV。type: go/kegg。
    orgdb: 物种注释包(模式物种如 org.Hs.eg.db；非模式需先自建 org.Xxx.eg.db)。
    go_source: orgdb(enrichGO) 或 custom(从 OrgDb 的 GO 列自建, 非模式物种)。
    kegg_source: online(rest.kegg.jp, 需 kegg_species) 或 gmt(用自建 gmt)。
    产出 GO_enrich.csv / KEGG_enrich.csv。注：OrgDb 需已安装，否则按提示安装。"""
    return _run("enrich.R", _clean(gene_list=gene_list, type=type, orgdb=orgdb, id_type=id_type,
                                   ont=ont, go_source=go_source, kegg_source=kegg_source,
                                   kegg_species=kegg_species, gmt=gmt, kegg_info=kegg_info,
                                   pvalueCutoff=pvalueCutoff, qvalueCutoff=qvalueCutoff), outdir)


@mcp.tool()
def rgraph_go_plot(enrich: str, outdir: str, kind: str = "bar", top_n: int = 10) -> dict[str, Any]:
    """GO 富集图(BP/CC/MF 三面板纵向拼接)。enrich 为 GO_enrich.csv(需 ONTOLOGY/Description/
    GeneRatio/pvalue/Count)。kind: bar(x=-log10p,填充Count) / dot(x=GeneRatio,填充-log10p,大小Count)。"""
    return _run("go_plot.R", _clean(enrich=enrich, kind=kind, top_n=top_n), outdir)


@mcp.tool()
def rgraph_kegg_plot(enrich: str, outdir: str, kind: str = "dot", top_n: int = 30) -> dict[str, Any]:
    """KEGG 富集图。enrich 为 KEGG_enrich.csv(需 Description/GeneRatio/pvalue/Count)。
    kind: dot(气泡) / bar(柱形)。top_n: 取 pvalue 最小的前 N 条通路。"""
    return _run("kegg_plot.R", _clean(enrich=enrich, kind=kind, top_n=top_n), outdir)


# ============================ 06 PPI ============================
@mcp.tool()
def rgraph_ppi(deg: str, info: str, links: str, outdir: str, score: int = 400,
               id_is_symbol: bool = False, orgdb: str = "org.Hs.eg.db") -> dict[str, Any]:
    """由差异基因 + STRING 库构建蛋白互作边表。deg: Deg_all.csv(gene_id)；info/links 为 STRING 的
    protein.info 与 protein.links 文件；score: combined_score 阈值。id_is_symbol=False 时用 orgdb 做
    ENSEMBL→SYMBOL。产出 Target_PPi.tsv + Edge_Node_count.tsv(可导入 Cytoscape)。"""
    return _run("ppi.R", _clean(deg=deg, info=info, links=links, score=score,
                                id_is_symbol=id_is_symbol, orgdb=orgdb), outdir)


# ============================ 07 GSEA ============================
@mcp.tool()
def rgraph_build_gmt(outdir: str, orgdb: str, type: str = "go", source: str = "orgdb",
                     keytype: str = "GID", kegg_species: str = "hsa",
                     min_count: int = 5) -> dict[str, Any]:
    """为 GSEA 构建 gmt 基因集。type: go/kegg。source: orgdb(从注释包的 GO/Pathway 列) 或
    online(KEGG 从 rest.kegg.jp + OrgDb 映射)。产出 GSEA_GO.gmt / GSEA_KEGG.gmt。需 orgdb 已安装。"""
    return _run("build_gmt.R", _clean(type=type, orgdb=orgdb, source=source, keytype=keytype,
                                     kegg_species=kegg_species, min_count=min_count), outdir)


@mcp.tool()
def rgraph_gsea(result: str, gmt: str, outdir: str, minGSSize: int = 5, maxGSSize: int = 1000,
                pvalueCutoff: float = 1.0, top_n: int = 5, desc_map: str | None = None,
                draw: bool = True) -> dict[str, Any]:
    """GSEA 分析。result 为差异结果表(按 log2FoldChange 排序)，gmt 为基因集文件。
    产出 GSEA_result.csv 及各方向 top-N 通路的 ES 图(UP/DOWN 子目录)。
    desc_map(可选 CSV: ID,Description) 用于补充通路描述。"""
    return _run("gsea.R", _clean(result=result, gmt=gmt, minGSSize=minGSSize, maxGSSize=maxGSSize,
                                 pvalueCutoff=pvalueCutoff, top_n=top_n, desc_map=desc_map,
                                 draw=draw), outdir)


@mcp.tool()
def rgraph_gsea_mountain(gsea_result: str, result: str, outdir: str,
                         geneset_ids: list[str] | None = None, n_top: int = 15) -> dict[str, Any]:
    """GSEA 山峦图(多通路 core_enrichment 基因的 log2FC 分布 + NES 点)。gsea_result 为 rgraph_gsea
    产出的 CSV；result 为差异结果表(取基因 log2FC)。geneset_ids 指定通路，缺省取 pvalue 最小的前 n_top。"""
    return _run("gsea_mountain.R", _clean(gsea_result=gsea_result, result=result,
                                          geneset_ids=geneset_ids, n_top=n_top), outdir)


# ============================ 非流程化绘图 (高级) ============================
@mcp.tool()
def rgraph_venn(outdir: str, sets: list[str] | None = None, folder: str | None = None,
                col: str | None = None, names: list[str] | None = None) -> dict[str, Any]:
    """韦恩图(2-5 组) + 交集成员表。sets: 各集合 CSV 路径列表；folder: 装 CSV 的目录(二选一)。
    col: 元素列名(默认自动识别 Element_name/gene_id/首列)。产出 venn.png/pdf + veen_table.csv。"""
    return _run("venn.R", _clean(sets=sets, folder=folder, col=col, names=names), outdir)


@mcp.tool()
def rgraph_quadrant(x: str, y: str, outdir: str, mode: str = "nine", x_name: str = "compare1",
                    y_name: str = "compare2", pcut: float = 0.05, log2fc: float = 1.0) -> dict[str, Any]:
    """九象限图/二象限图。x、y 为两个比较的差异结果 CSV(各含 gene_id,log2FoldChange,pvalue)。
    mode: nine(九象限) / four(二象限,仅同向基因 High/Low)。产出散点图 + 象限表。"""
    return _run("quadrant.R", _clean(x=x, y=y, mode=mode, x_name=x_name, y_name=y_name,
                                     pcut=pcut, log2fc=log2fc), outdir)


@mcp.tool()
def rgraph_stacked_volcano(deg_data: str, outdir: str, sig_metric: str = "pvalue",
                           pcut: float = 0.05, log2fc: float = 1.0, group_col: str = "TvsC",
                           top_n: int = 5) -> dict[str, Any]:
    """堆叠火山图(多比较组)。deg_data 含 gene_id,log2FoldChange,pvalue 及分组列(group_col,默认 TvsC)。
    按组抽动散点，点大小/深浅=|log2FC|，红上蓝下，每组每方向标注 top_n 个基因。"""
    return _run("stacked_volcano.R", _clean(deg_data=deg_data, sig_metric=sig_metric, pcut=pcut,
                                            log2fc=log2fc, group_col=group_col, top_n=top_n), outdir)


@mcp.tool()
def rgraph_gene_bar(deg: str, sample_group: str, outdir: str, gene_list: str | None = None,
                    genes: list[str] | None = None) -> dict[str, Any]:
    """单基因表达柱形图(对照 vs 处理，均值±SEM，显著性星号)。deg 为 Deg_all.csv(含 pvalue 与各
    样本归一化列)；sample_group 需 TvsC。基因来源: genes 优先，否则 gene_list(CSV)。每基因一张图。"""
    return _run("gene_bar.R", _clean(deg=deg, sample_group=sample_group, gene_list=gene_list,
                                     genes=genes), outdir)


@mcp.tool()
def rgraph_gene_correlation(fpkm: str, sample_group: str, outdir: str,
                            gene_list1: str | None = None, gene_list2: str | None = None,
                            genes1: list[str] | None = None,
                            genes2: list[str] | None = None) -> dict[str, Any]:
    """基因-基因相关性气泡热图(Pearson, 基于 log2(fpkm+1))。行基因=genes1/gene_list1，
    列基因=genes2/gene_list2(缺省=genes1)。圆点大小=|r|，蓝-白-红。产出热图 + correlation.csv。"""
    return _run("gene_correlation.R", _clean(fpkm=fpkm, sample_group=sample_group,
                                             gene_list1=gene_list1, gene_list2=gene_list2,
                                             genes1=genes1, genes2=genes2), outdir)


@mcp.tool()
def rgraph_pathway_trend(enrich: str, deg: str, outdir: str, kind: str = "diverge",
                         top_n: int | None = None) -> dict[str, Any]:
    """通路上下调基因统计图。enrich 为富集表(需 Description 与 geneID 列, 形如 a/b/c)；
    deg 为差异结果表(需 gene_id,log2FoldChange)。kind: diverge(左右发散条形) / stack(堆叠条形)。
    注: 默认 enrich 的 geneID 与 deg 的 gene_id 为同一 ID 类型(直接匹配)。"""
    return _run("pathway_trend.R", _clean(enrich=enrich, deg=deg, kind=kind, top_n=top_n), outdir)


@mcp.tool()
def rgraph_segmented_volcano(result: str, outdir: str, sig_metric: str = "pvalue",
                             pcut: float = 0.05, log2fc: float = 1.0, color_scheme: str = "rb",
                             break_lower: float | None = None,
                             break_upper: float | None = None) -> dict[str, Any]:
    """分段式火山图(y 轴断裂，适合个别基因 p 值极端时)。break_lower/upper 手动指定断裂区间，
    缺省自动推断。需 ggbreak 包(本机默认缺，按提示 install.packages('ggbreak'))。"""
    return _run("segmented_volcano.R", _clean(result=result, sig_metric=sig_metric, pcut=pcut,
                                              log2fc=log2fc, color_scheme=color_scheme,
                                              break_lower=break_lower, break_upper=break_upper), outdir)


@mcp.tool()
def rgraph_pathway_gene_heatmap(enrich: str, fpkm: str, sample_group: str, outdir: str,
                                kind: str = "correlation", id_col: str = "geneID",
                                min_count: int = 3, max_pathways: int = 6) -> dict[str, Any]:
    """通路富集基因的相关性热图/聚类热图（逐通路出图）。enrich 为 GO/KEGG 富集表
    (需 Description 与基因列 id_col, 默认 geneID)；fpkm 为表达矩阵。kind: correlation(基因-基因
    Pearson) / cluster(pheatmap 聚类热图)。注: id_col 基因需与 fpkm 的 gene_id 同 ID 类型。"""
    return _run("pathway_gene_heatmap.R", _clean(enrich=enrich, fpkm=fpkm, sample_group=sample_group,
                                                 kind=kind, id_col=id_col, min_count=min_count,
                                                 max_pathways=max_pathways), outdir)


@mcp.tool()
def rgraph_kmeans(fpkm: str, sample_group: str, outdir: str, gene_list: str | None = None,
                  genes: list[str] | None = None, k: int = 4, kmax: int = 10) -> dict[str, Any]:
    """目标基因 K-means 聚类：肘部图 + 聚类热图(行按簇排序、行/列注释) + 各簇表达趋势线 +
    各簇基因成员表。基因来源: genes 优先，否则 gene_list(CSV)。k: 簇数(可先看肘部图定 k)。"""
    return _run("kmeans.R", _clean(fpkm=fpkm, sample_group=sample_group, gene_list=gene_list,
                                   genes=genes, k=k, kmax=kmax), outdir)


@mcp.tool()
def rgraph_interactive_volcano(result: str, outdir: str, sig_metric: str = "pvalue",
                               pcut: float = 0.05, log2fc: float = 1.0,
                               color_scheme: str = "rb", include_no: bool = True) -> dict[str, Any]:
    """交互式火山图(plotly HTML，悬停显示基因/log2FC/-log10p)。result 为差异结果表。
    产出 .html（默认非 selfcontained，伴生 _files 目录，无需 pandoc）。"""
    return _run("interactive_volcano.R", _clean(result=result, sig_metric=sig_metric, pcut=pcut,
                                                log2fc=log2fc, color_scheme=color_scheme,
                                                include_no=include_no), outdir)


@mcp.tool()
def rgraph_sankey(enrich: str, outdir: str, id_col: str = "geneID",
                  pathway_col: str = "Description", top_n: int = 8) -> dict[str, Any]:
    """富集通路-基因桑基图(ggalluvial; 基因→通路流向)。enrich 为富集表(需通路名列
    pathway_col 与基因列 id_col, 形如 a/b/c)。top_n 限制展示通路数。"""
    return _run("sankey.R", _clean(enrich=enrich, id_col=id_col, pathway_col=pathway_col,
                                   top_n=top_n), outdir)


@mcp.tool()
def rgraph_ssgsea(expr: str, gmt: str, sample_group: str, outdir: str,
                  normalize: bool = True) -> dict[str, Any]:
    """ssGSEA 单样本基因集富集打分 + 各基因集分组箱线图。expr 为表达矩阵，gmt 为基因集。
    需 GSVA + GSEABase（本机默认缺，按提示 BiocManager::install(c('GSVA','GSEABase'))）。"""
    return _run("ssgsea.R", _clean(expr=expr, gmt=gmt, sample_group=sample_group,
                                   normalize=normalize), outdir)


@mcp.tool()
def rgraph_multilevel_scatter(expr: str, sample_group: str, outdir: str,
                              gene_list: str | None = None, genes: list[str] | None = None,
                              x_col: str | None = None, color_col: str | None = None,
                              sample_col: str | None = None) -> dict[str, Any]:
    """多级分组基因表达散点图(逐基因)。主分组为 x、次分组着色。sample_group 可含
    sample_name(1)/group_name(1)/group_name2 等多级列(缺省自动识别)。基因来源: genes 或 gene_list。"""
    return _run("multilevel_scatter.R", _clean(expr=expr, sample_group=sample_group,
                                               gene_list=gene_list, genes=genes, x_col=x_col,
                                               color_col=color_col, sample_col=sample_col), outdir)


@mcp.tool()
def rgraph_norm_matrix(count: str, sample_group: str, outdir: str, method: str = "deseq2",
                       min_mean: float = 1.0) -> dict[str, Any]:
    """输出标准化表达矩阵。method: deseq2(中位数比值标准化 count) / limma(voom logCPM)。
    产出 normalized_count.csv。注: deseq2 需安装 DESeq2；limma 本机已装。"""
    return _run("norm_matrix.R", _clean(count=count, sample_group=sample_group, method=method,
                                        min_mean=min_mean), outdir)


@mcp.tool()
def rgraph_interaction_diff(count: str, sample_group: str, outdir: str, sig_metric: str = "padj",
                           pcut: float = 0.05, log2fc: float = 1.0,
                           min_mean_count: float = 2.0) -> dict[str, Any]:
    """两因子交互作用差异分析(DESeq2 ~g1+g2+g1:g2，提取交互项)。sample_group 需含
    group_name1,group_name2,TvsC1,TvsC2。产出 01.DEseq2_result + Deg_all/down/up(可喂 rgraph_volcano)。
    需 DESeq2（本机默认缺，按提示安装）。"""
    return _run("interaction_diff.R", _clean(count=count, sample_group=sample_group,
                                             sig_metric=sig_metric, pcut=pcut, log2fc=log2fc,
                                             min_mean_count=min_mean_count), outdir)


@mcp.tool()
def rgraph_wgcna(expr: str, sample_group: str, outdir: str, power: int = 0,
                 min_module_size: int = 30, merge_cut: float = 0.25,
                 network_type: str = "unsigned", max_genes: int = 3000,
                 tomplot: bool = False, export_module: str | None = None,
                 export_threshold: float = 0.1) -> dict[str, Any]:
    """WGCNA 加权共表达网络分析。产出：软阈值图、模块树状图、模块-分组相关热图、
    特征向量邻接热图、gene_module/geneInfo 表。power=0 自动选最佳软阈值；max_genes 按方差限制
    基因数(控制耗时)。tomplot=True 时额外绘网络热图并导出 Cytoscape 边/点表(用于与 rgraph_network
    串联)；export_module 指定导出模块(缺省自动取最大非-grey 模块)，export_threshold 控制边数。"""
    return _run("wgcna.R", _clean(expr=expr, sample_group=sample_group, power=power,
                                  min_module_size=min_module_size, merge_cut=merge_cut,
                                  network_type=network_type, max_genes=max_genes,
                                  tomplot=tomplot, export_module=export_module,
                                  export_threshold=export_threshold), outdir)


@mcp.tool()
def rgraph_enrich_circos(enrich: str, outdir: str, type: str = "go", topN: int = 10,
                         split_count: bool | None = None, show_axis: bool = True) -> dict[str, Any]:
    """富集分析圈图(circlize 四轨道: 分类/背景基因数/前景基因(上下调)/RichFactor)。
    enrich 需含 pvalue,RichFactor,Bg_gene,Count[,Up,Down] 及 ONTOLOGY(GO)/Category(KEGG)。
    type: go/kegg。图例需 ComplexHeatmap(缺失则略去图例，圈图主体照常输出)。"""
    return _run("enrich_circos.R", _clean(enrich=enrich, type=type, topN=topN,
                                          split_count=split_count, show_axis=show_axis), outdir)


@mcp.tool()
def rgraph_virtual_knockout(count: str, sample_group: str, outdir: str, ko_gene: str,
                            ko_group: str, logfc: float = 0.5, hv_num: int = 5000) -> dict[str, Any]:
    """bulk RNA 虚拟敲除（GENIE3 推断调控网络 + bulkKnk 扰动）。sample_group 需含 group_name
    与 pheno_data。ko_gene/ko_group 为要敲除的基因与样本分组。产出扰动汇总/显著扰动基因
    表 + 双轴火山图。依赖 bulkKnk(课程本地源码包，install.packages('bulkKnk-main',repos=NULL,type='source'))
    与 GENIE3（Bioconductor）——本机默认缺，会返回缺包提示。"""
    return _run("virtual_knockout.R", _clean(count=count, sample_group=sample_group,
                                             ko_gene=ko_gene, ko_group=ko_group, logfc=logfc,
                                             hv_num=hv_num), outdir)


@mcp.tool()
def rgraph_network(outdir: str, mode: str = "matrix", expr: str | None = None,
                   sample_group: str | None = None, genes: list[str] | None = None,
                   method: str = "WGCNA", cor_method: str = "pearson", r_threshold: float = 0.7,
                   p_threshold: float = 0.05, transform: str = "none", max_features: int = 500,
                   node_annotation: str | None = None, edges: str | None = None,
                   nodes: str | None = None, from_col: str | None = None, to_col: str | None = None,
                   weight_col: str | None = None, directed: bool = False, layout: str = "gephi",
                   layout_module: str = "random", group_by: str = "Modularity",
                   fill_by: str = "Modularity", label: bool = False, pointlabel: str | None = None,
                   add_outer: bool = False) -> dict[str, Any]:
    """网络图(ggNetView)：共表达/相关/宏基因组共现网络，按模块着色。
    mode="matrix": expr(gene_id/OTU+样本) 构相关网络(method: WGCNA/cor/SPARCC/SpiecEasi/Hmisc；
      genes 限定子集否则按方差取 max_features)。mode="edge": edges(前两列 from,to[+weight])
      [+nodes] —— 可直接吃 rgraph_wgcna 的 Cytoscape 边表、rgraph_ppi 的 Target_PPi。
    layout: gephi 等；label/pointlabel(如 'top5')/add_outer 控制标签与模块边界。需 ggNetView 包。"""
    return _run("network.R", _clean(mode=mode, expr=expr, sample_group=sample_group, genes=genes,
                                    method=method, cor_method=cor_method, r_threshold=r_threshold,
                                    p_threshold=p_threshold, transform=transform,
                                    max_features=max_features, node_annotation=node_annotation,
                                    edges=edges, nodes=nodes, from_col=from_col, to_col=to_col,
                                    weight_col=weight_col, directed=directed, layout=layout,
                                    layout_module=layout_module, group_by=group_by, fill_by=fill_by,
                                    label=label, pointlabel=pointlabel, add_outer=add_outer), outdir)


if __name__ == "__main__":
    mcp.run()
