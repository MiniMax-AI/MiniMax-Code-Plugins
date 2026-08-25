"""植物抗病生物信息学 MCP Server（公共接口版）。

仅暴露公开数据库 API 与网页调度指引。不含本地基因组、本地 RNA-seq、物种专库映射表。

运行:
    uv run --directory <this-dir> server.py
"""
from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from bio_toolkit import (
    atted,
    bar,
    interpro,
    ncbi,
    plant,
    stringdb,
    structure,
    uniprot,
)

mcp = FastMCP("plant-public")


@mcp.tool()
def uniprot_summary(accession: str) -> dict[str, Any]:
    """获取 UniProt 蛋白的精简注释（名称/基因/物种/结构域/GO/关键词）。accession 如 P0DP23。"""
    return uniprot.summarize(accession)


@mcp.tool()
def uniprot_fasta(accession: str) -> str:
    """获取 UniProt 蛋白的 FASTA 序列。"""
    return uniprot.get_fasta(accession)


@mcp.tool()
def uniprot_search(query: str, size: int = 25) -> list[dict[str, Any]]:
    """UniProt 检索。query 用其查询语法，如 'gene:WRKY33 AND organism_id:4081'（番茄）。"""
    return uniprot.search(query, size=size)


@mcp.tool()
def ncbi_search(db: str, term: str, retmax: int = 20) -> dict[str, Any]:
    """NCBI 检索。db: nuccore/protein/gene/pubmed/assembly；term 如 'Solanum lycopersicum[Organism] AND WRKY[Gene]'。"""
    return ncbi.esearch(db, term, retmax=retmax)


@mcp.tool()
def ncbi_fetch(db: str, ids: str, rettype: str = "fasta") -> str:
    """按 ID 从 NCBI 下载记录。ids 逗号分隔；rettype: fasta/gb/gp。"""
    return ncbi.efetch(db, ids, rettype=rettype)


@mcp.tool()
def ncbi_search_fetch(db: str, term: str, rettype: str = "fasta", retmax: int = 5) -> dict[str, Any]:
    """NCBI 一步检索并抓取序列。"""
    return ncbi.search_and_fetch(db, term, rettype=rettype, retmax=retmax)


@mcp.tool()
def interproscan_run(sequence: str, email: str, result_type: str = "tsv") -> dict[str, Any]:
    """提交蛋白序列到 EBI InterProScan 并等待结果（结构域/家族/GO）。email 必填。用于 NLR/LRR/激酶等抗病结构域鉴定。"""
    return interpro.run_and_wait(sequence, email, result_type=result_type)


@mcp.tool()
def interproscan_submit(sequence: str, email: str) -> str:
    """仅提交 InterProScan 作业，返回 job_id（不等待）。"""
    return interpro.submit(sequence, email)


@mcp.tool()
def interproscan_result(job_id: str, result_type: str = "tsv") -> dict[str, Any]:
    """按 job_id 查询 InterProScan 状态并在完成时取结果。"""
    st = interpro.status(job_id)
    if st != "FINISHED":
        return {"job_id": job_id, "status": st}
    return {"job_id": job_id, "status": st, "result": interpro.result(job_id, result_type)}


@mcp.tool()
def pdb_entry(pdb_id: str) -> dict[str, Any]:
    """获取 RCSB PDB 条目元数据（标题/方法/分辨率）。"""
    return structure.pdb_entry(pdb_id)


@mcp.tool()
def pdb_search_by_sequence(sequence: str, identity_cutoff: float = 0.3, limit: int = 10) -> list[dict[str, Any]]:
    """按序列相似性搜索 PDB 实验结构（找同源模板）。"""
    return structure.pdb_search_by_sequence(sequence, identity_cutoff=identity_cutoff, limit=limit)


@mcp.tool()
def alphafold_summary(uniprot_acc: str) -> dict[str, Any]:
    """获取某 UniProt 的 AlphaFold 预测结构（含模型/PAE 下载链接）。优先于现算 ColabFold。"""
    return structure.alphafold_summary(uniprot_acc)


@mcp.tool()
def plant_list_resources() -> list[dict[str, str]]:
    """列出植物垂直资源及访问方式（api/web-only/notebook）。茄科公共入口为 Sol Genomics 与 Ensembl Plants。"""
    return plant.list_resources()


@mcp.tool()
def plant_resource_guide(key: str) -> dict[str, Any]:
    """获取某植物资源的调度指引。key 如 signalp6/tmhmm2/wolfpsort/plantcare/planttfdb/solgenomics/scplantdb/colabfold。"""
    return plant.get_resource(key)


@mcp.tool()
def ensembl_plants_gene(species: str, symbol: str) -> dict[str, Any]:
    """在 Ensembl Plants 按基因名查基因。species 如 solanum_lycopersicum。"""
    return plant.ensembl_lookup_symbol(species, symbol)


@mcp.tool()
def taxid(species: str) -> dict[str, Any]:
    """查询常用植物物种的 NCBI taxid。species 如 solanum_lycopersicum。"""
    tid = plant.TAXIDS.get(species.lower())
    return {"species": species, "taxid": tid, "known": list(plant.TAXIDS.keys())}


@mcp.tool()
def bar_gene_info(gene_id: str, species: str = "arabidopsis") -> dict[str, Any]:
    """BAR 拟南芥基因信息（位点/链向/别名/注释）。gene_id 如 AT3G26440。"""
    return bar.gene_info(gene_id, species=species)


@mcp.tool()
def bar_gene_function(gene_id: str) -> dict[str, Any]:
    """ThaleMine 拟南芥基因功能注释 + GeneRIF。gene_id 为 AGI。"""
    return bar.gene_function(gene_id)


@mcp.tool()
def bar_publications(gene_id: str) -> dict[str, Any]:
    """ThaleMine 拟南芥基因相关文献。gene_id 为 AGI。"""
    return bar.publications(gene_id)


@mcp.tool()
def bar_efp_views(species: str = "arabidopsis", view: str = "") -> dict[str, Any]:
    """eFP 发现：view 缺省列出全部 view→database 映射；给定 view(如 Biotic_Stress)返回该视图对照/处理样本分组。"""
    return bar.efp_views(species=species, view=view or None)


@mcp.tool()
def bar_efp_expression(gene_id: str, database: str = "klepikova", species: str = "arabidopsis") -> dict[str, Any]:
    """取拟南芥基因在指定 eFP database 的表达数值。"""
    return bar.efp_expression(gene_id, database=database, species=species)


@mcp.tool()
def bar_efp_image(gene_id: str, view: str = "Biotic_Stress", mode: str = "Absolute",
                  species: str = "arabidopsis") -> dict[str, Any]:
    """返回拟南芥基因 eFP 图像 URL（只返回 URL，不下载）。"""
    return bar.efp_image_url(gene_id, view=view, mode=mode, species=species)


@mcp.tool()
def atted_coexpression(gene_id: str, top_n: int = 100, cutoff: float | None = None,
                       platform: str = "u", db: str | None = None) -> dict[str, Any]:
    """拟南芥共表达基因（ATTED-II v5）。platform: u/m/r。"""
    return atted.coexpression(gene_id, top_n=top_n, cutoff=cutoff, platform=platform, db=db)


@mcp.tool()
def string_interactions(gene_id: str, required_score: int = 400, limit: int = 50) -> dict[str, Any]:
    """拟南芥蛋白的 STRING 互作伙伴（species=3702）。"""
    return stringdb.interaction_partners(gene_id, required_score=required_score, limit=limit)


@mcp.tool()
def string_enrichment(genes: str) -> dict[str, Any]:
    """对拟南芥基因集做 STRING 功能富集。genes 逗号/空格分隔多个。"""
    return stringdb.enrichment(genes)


if __name__ == "__main__":
    mcp.run()
