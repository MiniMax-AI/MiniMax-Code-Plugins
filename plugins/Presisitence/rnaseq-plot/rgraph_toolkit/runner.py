"""Rscript 执行引擎：定位 R、序列化参数、运行 rscripts/ 下的 R 模板并解析结果。

设计要点
--------
* **忠实 R 出图**：不在 Python 里重画，而是驱动一套清洗过的参数化 R 脚本（ggplot2/pheatmap/
  clusterProfiler/WGCNA 等），产出与课程一致风格的 png/pdf。
* **零额外 R 依赖传参**：参数以「R 源文件」形式落盘（`params <- list(...)`），R 端 `source()`
  即可，不依赖 jsonlite 等包。
* **优雅降级**：定位不到 Rscript → 返回可直接手动运行的脚本与命令；R 端缺包 → 返回缺失包名与
  安装建议，而不是抛出晦涩的 R 报错。
* **可复现**：以 `--no-init-file --no-site-file` 运行，屏蔽用户 .Rprofile/Rprofile.site
  的自动加载横幅，避免污染输出。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Rscript 定位
# ---------------------------------------------------------------------------

_COMMON_DIRS = [
    r"C:\Program Files\R",
    r"C:\Program Files (x86)\R",
]


def find_rscript() -> str | None:
    """按优先级定位 Rscript：环境变量 RGRAPH_RSCRIPT → PATH → 常见安装目录/注册表。"""
    env = os.environ.get("RGRAPH_RSCRIPT")
    if env and Path(env).exists():
        return env

    on_path = shutil.which("Rscript") or shutil.which("Rscript.exe")
    if on_path:
        return on_path

    # 常见安装根目录下搜 R-*/bin/Rscript.exe
    for root in _COMMON_DIRS:
        p = Path(root)
        if p.name.lower() == "bin" and (p / "Rscript.exe").exists():
            return str(p / "Rscript.exe")
        if p.exists():
            for sub in sorted(p.glob("R-*"), reverse=True):
                cand = sub / "bin" / "Rscript.exe"
                if cand.exists():
                    return str(cand)

    # Windows 注册表
    try:
        import winreg  # type: ignore

        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\R-core\R") as k:
                    install_path, _ = winreg.QueryValueEx(k, "InstallPath")
                cand = Path(install_path) / "bin" / "Rscript.exe"
                if cand.exists():
                    return str(cand)
            except OSError:
                continue
    except Exception:  # noqa: BLE001
        pass
    return None


# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------

def rscripts_dir() -> Path:
    """定位 rscripts 目录（源码布局为包的同级；wheel 布局为包内）。"""
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "rscripts", here / "rscripts"):
        if cand.is_dir():
            return cand
    return here.parent / "rscripts"


# ---------------------------------------------------------------------------
# Python -> R 字面量序列化
# ---------------------------------------------------------------------------

def _r_str(s: str) -> str:
    s = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t")
    return f'"{s}"'


def to_r_literal(value: Any) -> str:
    """把 Python 值转成 R 字面量表达式。"""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value):  # NaN
            return "NA"
        return repr(value)
    if isinstance(value, str):
        return _r_str(value)
    if isinstance(value, (list, tuple)):
        if not value:
            return "c()"
        return "c(" + ", ".join(to_r_literal(v) for v in value) + ")"
    if isinstance(value, dict):
        parts = []
        for k, v in value.items():
            name = str(k)
            key = name if name.isidentifier() else f"`{name}`"
            parts.append(f"{key} = {to_r_literal(v)}")
        return "list(" + ", ".join(parts) + ")"
    # 兜底：字符串化
    return _r_str(str(value))


def write_params_file(params: dict[str, Any], path: Path) -> None:
    """把参数写成 `params <- list(...)` 的 R 源文件。"""
    body = to_r_literal(params)
    path.write_text(f"params <- {body}\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------

_START_FLAGS = ["--no-init-file", "--no-site-file", "--no-restore"]


def build_command(script_name: str, params_file: Path, rscript: str | None = None) -> list[str] | None:
    rscript = rscript or find_rscript()
    if not rscript:
        return None
    script = rscripts_dir() / script_name
    common = rscripts_dir() / "_common.R"
    # trailing args: [params_file, _common.R 路径]，R 端 source(args[[2]]) 再读 args[[1]]
    return [rscript, *_START_FLAGS, str(script), str(params_file), str(common)]


def run_script(
    script_name: str,
    params: dict[str, Any],
    *,
    outdir: str | None = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """运行一个 R 模板脚本，返回结构化结果。

    返回字段：
      status: ok | missing_packages | r_not_found | error
      outputs: 产物文件绝对路径列表（R 端通过 `RGRAPH_OUTPUT:` 标记回传）
      packages: 缺失的 R 包（status=missing_packages 时）
      log: R 端 stdout+stderr（截断）
      command / script / params_file: 便于手动复现
    """
    if outdir:
        Path(outdir).mkdir(parents=True, exist_ok=True)
        params = {**params, "outdir": outdir}

    rscript = find_rscript()
    # 参数文件落在 outdir（便于复现），否则临时目录
    param_dir = Path(outdir) if outdir else Path(tempfile.mkdtemp(prefix="rgraph_"))
    params_file = param_dir / f".rgraph_params_{script_name.replace('.R', '')}.R"
    write_params_file(params, params_file)

    script_path = rscripts_dir() / script_name
    if not script_path.exists():
        return {"status": "error", "error": f"R 模板不存在: {script_path}",
                "script": str(script_path)}

    cmd = build_command(script_name, params_file, rscript)
    if cmd is None:
        common = rscripts_dir() / "_common.R"
        manual = f'"<Rscript路径>" {" ".join(_START_FLAGS)} "{script_path}" "{params_file}" "{common}"'
        return {
            "status": "r_not_found",
            "message": ("未找到 Rscript。请安装 R 或设置环境变量 RGRAPH_RSCRIPT 指向 Rscript(.exe)。"
                        "已生成可手动运行的脚本与参数文件。"),
            "script": str(script_path),
            "params_file": str(params_file),
            "manual_command": manual,
        }

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"R 运行超时(>{timeout}s)", "command": cmd}

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    combined = stdout + ("\n" + stderr if stderr else "")

    outputs: list[str] = []
    missing: list[str] = []
    for line in combined.splitlines():
        line = line.strip()
        if line.startswith("RGRAPH_OUTPUT:"):
            outputs.append(line[len("RGRAPH_OUTPUT:"):].strip())
        elif line.startswith("RGRAPH_MISSING_PACKAGES:"):
            pk = line[len("RGRAPH_MISSING_PACKAGES:"):].strip()
            missing = [x.strip() for x in pk.replace(";", ",").split(",") if x.strip()]

    log_tail = combined if len(combined) < 6000 else combined[-6000:]

    if missing:
        return {
            "status": "missing_packages",
            "packages": missing,
            "install_hint": _install_hint(missing),
            "script": str(script_path),
            "params_file": str(params_file),
            "log": log_tail,
        }

    if proc.returncode != 0:
        return {
            "status": "error",
            "returncode": proc.returncode,
            "error": "R 脚本执行失败，见 log。",
            "script": str(script_path),
            "params_file": str(params_file),
            "command": cmd,
            "log": log_tail,
        }

    return {
        "status": "ok",
        "outputs": outputs,
        "n_outputs": len(outputs),
        "script": str(script_path),
        "params_file": str(params_file),
        "log": log_tail,
    }


# ---------------------------------------------------------------------------
# 环境自检 / 安装建议
# ---------------------------------------------------------------------------

# CRAN vs Bioconductor 归属，用于给出正确的安装命令
_BIOC = {
    "DESeq2", "edgeR", "limma", "clusterProfiler", "enrichplot", "pathview",
    "ComplexHeatmap", "GSVA", "GSEABase", "fgsea", "WGCNA", "AnnotationDbi",
    "GO.db", "org.Hs.eg.db", "org.Mm.eg.db", "impute", "preprocessCore", "GENIE3",
}


def _install_hint(pkgs: list[str]) -> str:
    cran = [p for p in pkgs if p not in _BIOC]
    bioc = [p for p in pkgs if p in _BIOC]
    lines = []
    if cran:
        quoted = ", ".join(f'"{p}"' for p in cran)
        lines.append(f'install.packages(c({quoted}))')
    if bioc:
        quoted = ", ".join(f'"{p}"' for p in bioc)
        lines.append('if (!require("BiocManager")) install.packages("BiocManager")')
        lines.append(f'BiocManager::install(c({quoted}))')
    return "  ;  ".join(lines)


def check_packages(pkgs: list[str], rscript: str | None = None) -> dict[str, bool]:
    """查询若干 R 包是否已安装。"""
    rscript = rscript or find_rscript()
    if not rscript:
        return {p: False for p in pkgs}
    vec = ", ".join(f'"{p}"' for p in pkgs)
    code = f'i<-rownames(installed.packages()); for(x in c({vec})) cat(x,"=",x %in% i,"\\n")'
    try:
        proc = subprocess.run(
            [rscript, *_START_FLAGS, "-e", code],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
        )
    except Exception:  # noqa: BLE001
        return {p: False for p in pkgs}
    result: dict[str, bool] = {}
    for line in (proc.stdout or "").splitlines():
        if "=" in line:
            name, _, val = line.partition("=")
            result[name.strip()] = val.strip().upper().startswith("TRUE")
    for p in pkgs:
        result.setdefault(p, False)
    return result
