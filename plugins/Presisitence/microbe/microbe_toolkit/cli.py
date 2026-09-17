"""命令行自检入口：`microbe-cli` 检查 R 引擎与关键微生物组分析包是否就绪。"""
from __future__ import annotations

import sys

from . import runner

_KEY_PKGS = [
    "vegan", "ggplot2", "ggpubr", "dplyr", "tidyr", "reshape2", "pheatmap",
    "ggrepel", "igraph", "Hmisc", "randomForest", "ape", "scales", "circlize",
    "ggalluvial", "edgeR", "DESeq2", "ggtree", "phyloseq", "SpiecEasi",
]


def main() -> int:
    rscript = runner.find_rscript()
    print(f"Rscript: {rscript or '未找到 (设置 MICROBE_RSCRIPT 或安装 R)'}")
    print(f"mscripts 目录: {runner.mscripts_dir()}")
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
