"""蛋白结构访问：RCSB PDB + AlphaFold Protein Structure Database。

- RCSB PDB Data/Search API: https://data.rcsb.org / https://search.rcsb.org
- AlphaFold DB API: https://alphafold.ebi.ac.uk/api/prediction/{uniprot}
均无需 API key。
"""
from __future__ import annotations

from typing import Any

from .http import get_json, get_text, post

RCSB_DATA = "https://data.rcsb.org/rest/v1/core"
RCSB_SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"  # 搜索端点 (Search API v2)
RCSB_FILES = "https://files.rcsb.org/download"
AFDB = "https://alphafold.ebi.ac.uk/api/prediction"


# ---------- RCSB PDB ----------
def pdb_entry(pdb_id: str) -> dict[str, Any]:
    """获取 PDB 条目元数据 (标题、方法、分辨率等)。"""
    e = get_json(f"{RCSB_DATA}/entry/{pdb_id.upper()}")
    info = e.get("struct", {})
    exptl = e.get("exptl", [{}])
    cell = e.get("rcsb_entry_info", {})
    return {
        "pdb_id": pdb_id.upper(),
        "title": info.get("title"),
        "method": [x.get("method") for x in exptl],
        "resolution": cell.get("resolution_combined"),
        "polymer_entities": cell.get("polymer_entity_count_protein"),
        "source": f"https://www.rcsb.org/structure/{pdb_id.upper()}",
    }


def pdb_search_by_sequence(sequence: str, *, identity_cutoff: float = 0.3, limit: int = 10) -> list[dict[str, Any]]:
    """按序列相似性搜索 PDB (mmseqs2 后端)，用于给预测结构找实验结构模板。"""
    query = {
        "query": {
            "type": "terminal",
            "service": "sequence",
            "parameters": {
                "evalue_cutoff": 1,
                "identity_cutoff": identity_cutoff,
                "sequence_type": "protein",
                "value": sequence,
            },
        },
        "request_options": {"paginate": {"start": 0, "rows": limit}},
        "return_type": "polymer_entity",
    }
    resp = post(RCSB_SEARCH, json=query, accept="application/json")
    if resp.status_code == 204 or not resp.text.strip():
        return []
    data = resp.json()
    hits = []
    for item in data.get("result_set", []):
        hits.append({"identifier": item.get("identifier"), "score": item.get("score")})
    return hits


def download_pdb(pdb_id: str, fmt: str = "pdb") -> str:
    """下载结构坐标文件文本。fmt: pdb / cif。"""
    ext = "pdb" if fmt == "pdb" else "cif"
    return get_text(f"{RCSB_FILES}/{pdb_id.upper()}.{ext}")


# ---------- AlphaFold DB ----------
def alphafold_prediction(uniprot_acc: str) -> list[dict[str, Any]]:
    """获取某 UniProt 登录号的 AlphaFold 预测结构元数据 (含模型/PAE 下载链接)。"""
    return get_json(f"{AFDB}/{uniprot_acc}")


def alphafold_summary(uniprot_acc: str) -> dict[str, Any]:
    """精简 AlphaFold 结果，给出模型与置信度文件下载链接。"""
    preds = alphafold_prediction(uniprot_acc)
    if not preds:
        return {"uniprot": uniprot_acc, "found": False}
    p = preds[0]
    return {
        "uniprot": uniprot_acc,
        "found": True,
        "organism": p.get("organismScientificName"),
        "gene": p.get("gene"),
        "uniprot_description": p.get("uniprotDescription"),
        "model_pdb_url": p.get("pdbUrl"),
        "model_cif_url": p.get("cifUrl"),
        "pae_image_url": p.get("paeImageUrl"),
        "pae_doc_url": p.get("paeDocUrl"),
        "source": f"https://alphafold.ebi.ac.uk/entry/{uniprot_acc}",
    }
