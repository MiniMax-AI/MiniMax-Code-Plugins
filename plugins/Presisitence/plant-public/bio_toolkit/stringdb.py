"""STRING (string-db.org) 蛋白互作与功能富集 API 封装。

拟南芥 (species=3702) 蛋白-蛋白互作网络与功能富集(GO/KEGG/Pfam/InterPro)。
公开 REST API（GET，JSON）。STRING 可直接解析 AGI（如 AT3G26440）。
"""
from __future__ import annotations

from typing import Any

from .http import get_json

STRING_API = "https://string-db.org/api"
ARABIDOPSIS = 3702
CALLER = "plant-bio-mcp"


def _ids(genes: str | list[str]) -> str:
    """把单个/多个基因标识符组装成 STRING 约定格式（多标识符用 %0d 分隔）。"""
    if isinstance(genes, str):
        parts = [g for g in genes.replace(",", " ").split() if g]
    else:
        parts = [str(g).strip() for g in genes if str(g).strip()]
    return "\r".join(parts)


def interaction_partners(
    gene_id: str,
    species: int = ARABIDOPSIS,
    required_score: int = 400,
    limit: int = 50,
) -> dict[str, Any]:
    """某拟南芥蛋白的 STRING 互作伙伴。required_score 为 0-1000 阈值(400≈中等)；返回项 score 为 0-1。"""
    params = {
        "identifiers": gene_id.strip(),
        "species": species,
        "required_score": required_score,
        "limit": limit,
        "caller_identity": CALLER,
    }
    return {
        "gene_id": gene_id.strip(),
        "species": species,
        "required_score": required_score,
        "partners": get_json(f"{STRING_API}/json/interaction_partners", params=params),
    }


def enrichment(genes: str | list[str], species: int = ARABIDOPSIS) -> dict[str, Any]:
    """对拟南芥基因集做功能富集(GO/KEGG/Pfam/InterPro/UniProt Keywords)。genes 支持单个或多个(逗号/空格分隔)。"""
    params = {"identifiers": _ids(genes), "species": species, "caller_identity": CALLER}
    return {"species": species, "enrichment": get_json(f"{STRING_API}/json/enrichment", params=params)}
