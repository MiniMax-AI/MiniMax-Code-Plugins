"""NCBI 数据库访问 (E-utilities)。

文档: https://www.ncbi.nlm.nih.gov/books/NBK25501/
无需 API key（可选设置 NCBI_API_KEY 环境变量提高频率上限）。
遵守 NCBI 频率限制：无 key 时 <=3 请求/秒。
"""
from __future__ import annotations

import os
from typing import Any

from .http import get_json, get_text

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def _common() -> dict[str, str]:
    p = {"tool": "plant-public-mcp", "email": "researcher@example.org"}
    key = os.environ.get("NCBI_API_KEY")
    if key:
        p["api_key"] = key
    return p


def esearch(db: str, term: str, retmax: int = 20) -> dict[str, Any]:
    """检索数据库，返回匹配的 ID 列表。

    db 常用: nuccore(核酸), protein(蛋白), gene(基因), pubmed(文献), assembly(基因组)
    term 例: "Solanum lycopersicum[Organism] AND WRKY[Gene]"
    """
    params = {**_common(), "db": db, "term": term, "retmax": str(retmax), "retmode": "json"}
    data = get_json(f"{EUTILS}/esearch.fcgi", params=params)
    result = data.get("esearchresult", {})
    return {
        "count": result.get("count"),
        "ids": result.get("idlist", []),
        "query": term,
        "db": db,
    }


def esummary(db: str, ids: list[str] | str) -> list[dict[str, Any]]:
    """获取 ID 的摘要信息。"""
    id_str = ids if isinstance(ids, str) else ",".join(ids)
    params = {**_common(), "db": db, "id": id_str, "retmode": "json"}
    data = get_json(f"{EUTILS}/esummary.fcgi", params=params)
    result = data.get("result", {})
    uids = result.get("uids", [])
    return [result[u] for u in uids if u in result]


def efetch(db: str, ids: list[str] | str, rettype: str = "fasta", retmode: str = "text") -> str:
    """下载序列/记录。rettype 例: fasta / gb / gp。返回文本。"""
    id_str = ids if isinstance(ids, str) else ",".join(ids)
    params = {**_common(), "db": db, "id": id_str, "rettype": rettype, "retmode": retmode}
    return get_text(f"{EUTILS}/efetch.fcgi", params=params)


def search_and_fetch(db: str, term: str, rettype: str = "fasta", retmax: int = 5) -> dict[str, Any]:
    """一步检索并抓取序列，返回 ID 与文本内容。"""
    s = esearch(db, term, retmax=retmax)
    if not s["ids"]:
        return {"ids": [], "records": "", "count": s["count"], "query": term}
    records = efetch(db, s["ids"], rettype=rettype)
    return {"ids": s["ids"], "records": records, "count": s["count"], "query": term}
