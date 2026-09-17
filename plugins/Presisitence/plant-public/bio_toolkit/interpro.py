"""EBI InterProScan 结构域/家族注释 (REST API)。

文档: https://www.ebi.ac.uk/jdispatcher/docs/webservices/
这是异步作业：submit -> poll status -> fetch result。
抗病基因家族鉴定关键工具 (NLR/NB-ARC、LRR、Pkinase、WRKY 等结构域)。
"""
from __future__ import annotations

import time
from typing import Any

from .http import get_text, post

BASE = "https://www.ebi.ac.uk/Tools/services/rest/iprscan5"


def submit(sequence: str, email: str, *, title: str = "plant-bio-mcp") -> str:
    """提交序列，返回 job id。sequence 为蛋白 FASTA 或纯序列。email 必填 (EBI 要求)。"""
    data = {
        "email": email,
        "title": title,
        "sequence": sequence,
        "goterms": "true",
        "pathways": "true",
    }
    resp = post(f"{BASE}/run", data=data)
    return resp.text.strip()


def status(job_id: str) -> str:
    """查询作业状态: RUNNING / FINISHED / ERROR / NOT_FOUND 等。"""
    return get_text(f"{BASE}/status/{job_id}").strip()


def result_types(job_id: str) -> str:
    return get_text(f"{BASE}/resulttypes/{job_id}")


def result(job_id: str, result_type: str = "json") -> str:
    """获取结果。result_type: json / tsv / gff / xml / svg 等。"""
    return get_text(f"{BASE}/result/{job_id}/{result_type}")


def run_and_wait(
    sequence: str,
    email: str,
    *,
    result_type: str = "tsv",
    poll_interval: float = 15.0,
    max_wait: float = 900.0,
) -> dict[str, Any]:
    """提交并阻塞等待完成，返回结果文本。

    InterProScan 通常需 1-5 分钟。max_wait 默认 15 分钟。
    """
    job_id = submit(sequence, email)
    waited = 0.0
    while waited < max_wait:
        st = status(job_id)
        if st == "FINISHED":
            return {"job_id": job_id, "status": st, "result_type": result_type,
                    "result": result(job_id, result_type)}
        if st in ("ERROR", "FAILURE", "NOT_FOUND"):
            return {"job_id": job_id, "status": st, "result": ""}
        time.sleep(poll_interval)
        waited += poll_interval
    return {"job_id": job_id, "status": "TIMEOUT", "result": "",
            "note": f"超过 {max_wait}s 未完成，可稍后用 job_id 查询"}
