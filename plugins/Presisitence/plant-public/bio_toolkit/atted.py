"""ATTED-II (atted.jp) 共表达数据库 API v5 封装。

拟南芥共表达网络：给定基因返回共表达基因及 z 分数（找共调控基因/候选上游 TF）。
公开 REST API（GET，JSON）。
"""
from __future__ import annotations

from typing import Any

from .http import get_json

ATTED_API5 = "https://atted.jp/api5/"
# 平台→当前数据库 id（版本随 ATTED 更新，可用 db 参数覆盖；截至 2026-07）。
# 注意：ATTED 只认带版本号的库 id，裸 'Ath-r' 会被静默当成统一库。
_PLATFORM_DB = {"u": None, "r": "Ath-r.c5-0", "m": "Ath-m.c8-0"}


def coexpression(
    gene_id: str,
    top_n: int = 100,
    cutoff: float | None = None,
    platform: str = "u",
    db: str | None = None,
) -> dict[str, Any]:
    """拟南芥共表达基因（AGI + z 分数）。gene_id: AGI(如 At3g26440) 或 Entrez ID。
    platform: u/m/r（统一/微阵列/RNA-seq）；db 显式指定完整 ATTED 库 id(如 Ath-r.c5-0)时优先于 platform。"""
    pf = platform.lower()
    if db is None and pf not in _PLATFORM_DB:
        return {"error": f"platform 须为 u/m/r，收到 {platform!r}", "platforms": list(_PLATFORM_DB)}
    resolved_db = db if db is not None else _PLATFORM_DB.get(pf)
    params: dict[str, Any] = {"gene": gene_id.strip(), "topN": top_n}
    if cutoff is not None:
        params["value"] = cutoff
    if resolved_db:
        params["db"] = resolved_db
    return {
        "gene_id": gene_id.strip(),
        "platform": pf if db is None else None,
        "db": resolved_db,
        "top_n": top_n,
        "cutoff": cutoff,
        "result": get_json(ATTED_API5, params=params),
    }
