"""命令行自检入口：`rgraph-cli` 检查 R 引擎与关键包是否就绪。"""
from __future__ import annotations

import sys

from . import runner

_KEY_PKGS = [
    "ggplot2", "dplyr", "tidyr", "stringr", "pheatmap", "ggrepel",
    "DESeq2", "edgeR", "limma", "clusterProfiler", "enrichplot",
    "pathview", "circlize", "ComplexHeatmap", "WGCNA", "VennDiagram",
    "GSVA", "fgsea", "ggpubr", "patchwork", "reshape2",
]


def main() -> int:
    rscript = runner.find_rscript()
    print(f"Rscript: {rscript or '未找到 (设置 RGRAPH_RSCRIPT 或安装 R)'}")
    print(f"rscripts 目录: {runner.rscripts_dir()}")
    if not rscript:
        return 1
    status = runner.check_packages(_KEY_PKGS, rscript=rscript)
    print("\nR 包状态:")
    for pkg, ok in status.items():
        print(f"  [{'x' if ok else ' '}] {pkg}")
    missing = [p for p, ok in status.items() if not ok]
    if missing:
        print("\n缺失包安装建议:")
        print("  " + runner._install_hint(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
