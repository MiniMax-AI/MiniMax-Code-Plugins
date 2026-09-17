"""BAR (Bio-Analytic Resource, bar.utoronto.ca) API 封装。

拟南芥模式参考数据：基因信息、ThaleMine 功能注释/GeneRIF/文献、
eFP 表达数值与 eFP 图像（含 Biotic Stress 生物胁迫）。
全部为公开 REST API（GET，JSON）。绝不编造返回数据：失败时返回错误与可选项。
"""
from __future__ import annotations

from typing import Any

from .http import BioHTTPError, get, get_json

BAR_API = "https://bar.utoronto.ca/api"


def _unwrap(resp: Any) -> Any:
    """BAR 多数端点包一层 {"wasSuccessful":true,"data":...}；成功则取 data，否则原样返回。"""
    if isinstance(resp, dict) and resp.get("wasSuccessful") and "data" in resp:
        return resp["data"]
    return resp


def _intermine_rows(resp: Any) -> list[dict[str, Any]]:
    """把 ThaleMine(InterMine) 的 {views/columnHeaders, results:[[...]]} 转成按列名归键的字典列表。"""
    if not isinstance(resp, dict):
        return []
    cols = resp.get("views") or resp.get("columnHeaders") or []
    out: list[dict[str, Any]] = []
    for row in resp.get("results") or []:
        out.append({c: v for c, v in zip(cols, row)} if isinstance(row, list) else row)
    return out


def gene_info(gene_id: str, species: str = "arabidopsis") -> dict[str, Any]:
    """BAR 基因信息（位点/链向/别名/注释）。gene_id 如 AT3G26440。"""
    gid = gene_id.strip()
    resp = get_json(f"{BAR_API}/gene_information/single_gene_query/{species}/{gid}")
    return {"gene_id": gid, "species": species, "data": _unwrap(resp)}


def gene_function(gene_id: str) -> dict[str, Any]:
    """ThaleMine 拟南芥基因功能注释 + GeneRIF。gene_id 为 AGI（如 At3g26440）。"""
    gid = gene_id.strip()
    info = get_json(f"{BAR_API}/thalemine/gene_information/{gid}")
    rifs = get_json(f"{BAR_API}/thalemine/gene_rifs/{gid}")
    return {"gene_id": gid, "gene_information": _intermine_rows(info), "gene_rifs": _intermine_rows(rifs)}


def publications(gene_id: str) -> dict[str, Any]:
    """ThaleMine 拟南芥基因相关文献。gene_id 为 AGI。"""
    gid = gene_id.strip()
    pubs = get_json(f"{BAR_API}/thalemine/publications/{gid}")
    return {"gene_id": gid, "publications": _intermine_rows(pubs)}


def efp_views(species: str = "arabidopsis", view: str | None = None) -> dict[str, Any]:
    """eFP 发现工具。view 缺省：列出全部 view→database 映射；
    给定 view（如 Biotic_Stress）：返回该视图对照/处理样本分组（病原实验设计）。"""
    if view:
        resp = get_json(f"{BAR_API}/microarray_gene_expression/{species}/{view}/samples")
        return _unwrap(resp)  # 已含 {species, view, groups}
    resp = get_json(f"{BAR_API}/microarray_gene_expression/{species}/databases")
    return _unwrap(resp)  # 已含 {species, databases}


def efp_expression(gene_id: str, database: str = "klepikova", species: str = "arabidopsis") -> dict[str, Any]:
    """取基因在指定 eFP database 的表达数值（RNA-seq 类库如 klepikova 可用）。
    注：微阵列库(atgenexp_*/生物胁迫)此端点暂不支持数值——生物胁迫请用 efp_image 取图、efp_views 取实验设计。"""
    gid = gene_id.strip()
    url = f"{BAR_API}/gene_expression/expression/{database}/{gid}"
    try:
        resp = get_json(url)
    except BioHTTPError as exc:
        return {
            "gene_id": gid,
            "database": database,
            "error": f"该 database 在表达值端点不可用（{exc}）。RNA-seq 库(如 klepikova)可用；"
                     "微阵列库/生物胁迫请用 bar_efp_image 取图或 bar_efp_views 查实验设计。",
        }
    return {"gene_id": gid, "database": database, "species": species, "data": _unwrap(resp)}


def efp_image_url(
    gene_id: str,
    view: str = "Biotic_Stress",
    mode: str = "Absolute",
    species: str = "arabidopsis",
    check: bool = False,
) -> dict[str, Any]:
    """拟南芥基因 eFP 图像 URL（含 Biotic_Stress 生物胁迫；默认只返回 URL，不下载/不落盘）。
    view 如 Biotic_Stress/Abiotic_Stress/Developmental_Map；mode Absolute/Relative/Compare。
    check=True 时做一次状态探测（会请求但不保存）。"""
    gid = gene_id.strip()
    url = f"{BAR_API}/efp_image/efp_{species}/{view}/{mode}/{gid}"
    reachable: bool | None = None
    if check:
        try:
            reachable = get(url).status_code == 200
        except BioHTTPError:
            reachable = False
    return {"gene_id": gid, "view": view, "mode": mode, "url": url, "reachable": reachable}
