"""UniProt 蛋白数据库访问 (REST API)。

文档: https://www.uniprot.org/help/api_queries
无需 API key。
"""
from __future__ import annotations

from typing import Any

from .http import get_json, get_text

BASE = "https://rest.uniprot.org/uniprotkb"


def get_entry(accession: str) -> dict[str, Any]:
    """按登录号获取完整条目 (JSON)。例: P0DP23。"""
    return get_json(f"{BASE}/{accession}.json")


def get_fasta(accession: str) -> str:
    """获取 FASTA 序列（保留原始头信息与 ID）。"""
    return get_text(f"{BASE}/{accession}.fasta")


def search(
    query: str,
    *,
    fields: str = "accession,id,protein_name,organism_name,length,gene_names",
    size: int = 25,
) -> list[dict[str, Any]]:
    """检索 UniProtKB。

    query 支持 UniProt 查询语法，例如:
      - "gene:WRKY33 AND organism_id:4081"  (番茄 Solanum lycopersicum taxid=4081)
      - "kinase AND reviewed:true"
    """
    params = {"query": query, "fields": fields, "size": str(size), "format": "json"}
    data = get_json(f"{BASE}/search", params=params)
    return data.get("results", [])


def summarize(accession: str) -> dict[str, Any]:
    """把冗长的 UniProt JSON 精简为抗病研究关注的关键字段。"""
    e = get_entry(accession)
    protein = (
        e.get("proteinDescription", {})
        .get("recommendedName", {})
        .get("fullName", {})
        .get("value")
    )
    organism = e.get("organism", {}).get("scientificName")
    seq = e.get("sequence", {})
    genes = [g.get("geneName", {}).get("value") for g in e.get("genes", []) if g.get("geneName")]

    # 结构域 / 特征
    domains: list[str] = []
    for f in e.get("features", []):
        if f.get("type") in ("Domain", "Transmembrane", "Signal", "Region"):
            desc = f.get("description") or f.get("type")
            loc = f.get("location", {})
            start = loc.get("start", {}).get("value")
            end = loc.get("end", {}).get("value")
            domains.append(f"{f['type']}: {desc} [{start}-{end}]")

    # 关键词 / GO
    keywords = [k.get("name") for k in e.get("keywords", [])]
    go_terms = []
    for ref in e.get("uniProtKBCrossReferences", []):
        if ref.get("database") == "GO":
            props = {p["key"]: p["value"] for p in ref.get("properties", [])}
            go_terms.append(f"{ref.get('id')} {props.get('GoTerm', '')}")

    return {
        "accession": accession,
        "protein_name": protein,
        "gene_names": genes,
        "organism": organism,
        "length": seq.get("length"),
        "features": domains[:30],
        "keywords": keywords,
        "go_terms": go_terms[:30],
        "source": f"{BASE}/{accession}",
    }
