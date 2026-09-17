"""独立命令行入口：不启动 MCP 也能直接调度公共数据库。

用法示例:
    uv run plant-cli uniprot summary P0DP23
    uv run plant-cli ncbi search protein "Solanum lycopersicum[Organism] AND WRKY[Gene]"
    uv run plant-cli alphafold P0DP23
    uv run plant-cli plant list
    uv run plant-cli plant guide solgenomics
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import (
    atted,
    bar,
    interpro,
    ncbi,
    plant,
    stringdb,
    structure,
    uniprot,
)


def _out(obj: Any) -> None:
    if isinstance(obj, str):
        print(obj)
    else:
        print(json.dumps(obj, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="plant-cli", description="植物抗病生信公共接口 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    up = sub.add_parser("uniprot", help="UniProt")
    up.add_argument("action", choices=["summary", "fasta", "search"])
    up.add_argument("value")
    up.add_argument("--size", type=int, default=25)

    nc = sub.add_parser("ncbi", help="NCBI E-utilities")
    nc.add_argument("action", choices=["search", "fetch", "search-fetch"])
    nc.add_argument("db")
    nc.add_argument("value")
    nc.add_argument("--rettype", default="fasta")
    nc.add_argument("--retmax", type=int, default=10)

    af = sub.add_parser("alphafold", help="AlphaFold DB")
    af.add_argument("uniprot")

    pdb = sub.add_parser("pdb", help="RCSB PDB 条目")
    pdb.add_argument("pdb_id")

    ip = sub.add_parser("interpro", help="InterProScan")
    ip.add_argument("action", choices=["run", "status", "result"])
    ip.add_argument("arg1", help="run: fasta文件; status/result: job_id")
    ip.add_argument("email_or_type", nargs="?", default="tsv")

    pl = sub.add_parser("plant", help="植物垂直资源")
    pl.add_argument("action", choices=["list", "guide", "ensembl", "taxid"])
    pl.add_argument("arg1", nargs="?")
    pl.add_argument("arg2", nargs="?")

    ba = sub.add_parser("bar", help="BAR/ThaleMine 拟南芥资源")
    ba.add_argument("action", choices=["info", "function", "pubs", "views", "expr", "image"])
    ba.add_argument("arg1", nargs="?", help="基因ID (AGI)；views 时为 view 名(可选)")
    ba.add_argument("arg2", nargs="?", help="expr: database；image: view")

    at = sub.add_parser("atted", help="ATTED-II 拟南芥共表达")
    at.add_argument("gene", help="基因ID (AGI)")
    at.add_argument("--top", type=int, default=100)
    at.add_argument("--platform", default="u", help="u/m/r")

    st = sub.add_parser("string", help="STRING 拟南芥互作/富集 (species=3702)")
    st.add_argument("action", choices=["partners", "enrichment"])
    st.add_argument("genes")
    st.add_argument("--score", type=int, default=400)
    return p


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    args = build_parser().parse_args(argv)

    if args.cmd == "uniprot":
        if args.action == "summary":
            _out(uniprot.summarize(args.value))
        elif args.action == "fasta":
            _out(uniprot.get_fasta(args.value))
        else:
            _out(uniprot.search(args.value, size=args.size))

    elif args.cmd == "ncbi":
        if args.action == "search":
            _out(ncbi.esearch(args.db, args.value, retmax=args.retmax))
        elif args.action == "fetch":
            _out(ncbi.efetch(args.db, args.value, rettype=args.rettype))
        else:
            _out(ncbi.search_and_fetch(args.db, args.value, rettype=args.rettype, retmax=args.retmax))

    elif args.cmd == "alphafold":
        _out(structure.alphafold_summary(args.uniprot))

    elif args.cmd == "pdb":
        _out(structure.pdb_entry(args.pdb_id))

    elif args.cmd == "interpro":
        if args.action == "run":
            seq = Path(args.arg1).read_text(encoding="utf-8") if Path(args.arg1).exists() else args.arg1
            _out(interpro.run_and_wait(seq, args.email_or_type))
        elif args.action == "status":
            _out({"job_id": args.arg1, "status": interpro.status(args.arg1)})
        else:
            _out(interpro.result(args.arg1, args.email_or_type))

    elif args.cmd == "plant":
        if args.action == "list":
            _out(plant.list_resources())
        elif args.action == "guide":
            _out(plant.get_resource(args.arg1 or ""))
        elif args.action == "ensembl":
            _out(plant.ensembl_lookup_symbol(args.arg1, args.arg2))
        else:
            key = (args.arg1 or "").lower()
            _out({"species": key, "taxid": plant.TAXIDS.get(key), "known": list(plant.TAXIDS)})

    elif args.cmd == "bar":
        if args.action == "info":
            _out(bar.gene_info(args.arg1))
        elif args.action == "function":
            _out(bar.gene_function(args.arg1))
        elif args.action == "pubs":
            _out(bar.publications(args.arg1))
        elif args.action == "views":
            _out(bar.efp_views(view=args.arg1 or None))
        elif args.action == "expr":
            _out(bar.efp_expression(args.arg1, database=args.arg2 or "klepikova"))
        else:
            _out(bar.efp_image_url(args.arg1, view=args.arg2 or "Biotic_Stress"))

    elif args.cmd == "atted":
        _out(atted.coexpression(args.gene, top_n=args.top, platform=args.platform))

    elif args.cmd == "string":
        if args.action == "partners":
            _out(stringdb.interaction_partners(args.genes, required_score=args.score))
        else:
            _out(stringdb.enrichment(args.genes))

    return 0


if __name__ == "__main__":
    sys.exit(main())
