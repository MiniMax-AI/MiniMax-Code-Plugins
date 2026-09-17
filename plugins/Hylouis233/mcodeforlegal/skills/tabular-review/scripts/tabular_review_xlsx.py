#!/usr/bin/env python3
"""CSV fallback writer for the tabular-review skill (stdlib only).

Reads an N-documents x M-questions extraction grid from JSON and writes four
RFC 4180 CSV files mirroring the XLSX four-sheet contract: review.csv (one
row per document, Q / Q_source / Q_status triples plus an empty Verified
sign-off column), flags.csv (work queue sorted by dual-axis severity),
_schema.csv (column definitions), _summary.csv (counts and rule reminders).

Hard rules built in: unsourced cells become 未见, never fabricated; external
text gets a single-quote prefix (formula-injection defense); no
confidence-percentage columns anywhere.
"""

import argparse, csv, json, sys
from datetime import date
from pathlib import Path

NOT_FOUND = "未见"  # valid answer: the document does not say
STATUS = {"green": "🟢", "yellow": "🟡", "red": "🔴"}
LEGAL_ORDER = {"🔴": 0, "🟠": 1, "🟡": 2, "🟢": 3}
FRICTION_ORDER = {"阻碍": 0, "拖慢": 1, "费解": 2, "无感": 3}


def q(value):
    """Single-quote prefix for external text (injection defense)."""
    text = "" if value is None else str(value)
    return "'" + text if text else ""


def load_grid(path):
    """Load input.json; index cells by (document, question)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    docs, questions = data["documents"], data["questions"]
    cells = {(c["document"], c["question"]): c for c in data.get("cells", [])}
    return docs, questions, cells


def write_csv(path, header, rows):
    """csv module with QUOTE_MINIMAL follows RFC 4180 for , " and newlines."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)


def write_review(outdir, docs, questions, cells):
    """One row per document; Verified stays blank for the human reviewer."""
    header = ["document"]
    for i in range(len(questions)):
        header += [f"Q{i + 1}", f"Q{i + 1}_source", f"Q{i + 1}_status"]
    header.append("Verified")
    rows = []
    for doc in docs:
        row = [q(doc)]
        for question in questions:
            cell = cells.get((doc, question), {})
            row += [q(cell.get("answer") or NOT_FOUND), q(cell.get("source", "")),
                    STATUS.get(cell.get("status", ""), "")]
        row.append("")  # Verified is filled by humans, never by the skill
        rows.append(row)
    write_csv(outdir / "review.csv", header, rows)


def write_flags(outdir, questions, cells):
    """Flagged cells as a work queue, sorted by dual-axis severity."""
    qid = {text: f"Q{i + 1}" for i, text in enumerate(questions)}
    flagged = [c for c in cells.values() if c.get("flag")]
    flagged.sort(key=lambda c: (LEGAL_ORDER.get(c.get("legal_risk", ""), 9),
                                FRICTION_ORDER.get(c.get("business_friction", ""), 9)))
    rows = [[q(c["document"]), qid.get(c["question"], "?"), q(c["question"]),
             q(c["flag"]), c.get("legal_risk", ""), c.get("business_friction", ""),
             q(c.get("action", ""))] for c in flagged]
    write_csv(outdir / "flags.csv",
              ["document", "question_id", "question", "flag", "legal_risk",
               "business_friction", "suggested_action"], rows)
    return flagged


def write_schema(outdir, questions):
    """Self-documenting column definitions for all four CSV files."""
    rows = [["document", "review", "document identifier, one row per document"]]
    for i, question in enumerate(questions):
        qn = f"Q{i + 1}"
        rows.append([qn, "review", q(question)])
        rows.append([f"{qn}_source", "review",
                     f"source quote | location for {qn}; empty = {NOT_FOUND}"])
        rows.append([f"{qn}_status", "review",
                     "🟢 sourced / 🟡 ambiguous / 🔴 hits negative condition"])
    rows += [
        ["Verified", "review", "human sign-off: ✓ / ✗ / ? (blank until reviewed)"],
        ["flag", "flags", "finding that needs human verification"],
        ["legal_risk", "flags", "G9 legal severity: 🔴 🟠 🟡 🟢"],
        ["business_friction", "flags", "G9 business friction: 阻碍 拖慢 费解 无感"],
        ["suggested_action", "flags", "next step proposed by the reviewer"],
        ["(rule)", "all", "external text is single-quote prefixed (injection defense)"],
        ["(rule)", "all", "no confidence-percentage columns; 未见 is a valid answer"],
    ]
    write_csv(outdir / "_schema.csv", ["column", "sheet", "definition"], rows)


def write_summary(outdir, docs, questions, cells, flagged):
    """Outcome counts plus the hard-rule reminders."""
    total = len(docs) * len(questions)
    found = sum(1 for d in docs for qu in questions
                if cells.get((d, qu), {}).get("answer"))
    by_risk = {}
    for c in flagged:
        key = c.get("legal_risk", "?")
        by_risk[key] = by_risk.get(key, 0) + 1
    risk_text = " ".join(f"{k}:{v}" for k, v in sorted(
        by_risk.items(), key=lambda kv: LEGAL_ORDER.get(kv[0], 9)))
    rows = [
        ["generated", str(date.today())],
        ["documents", len(docs)],
        ["questions", len(questions)],
        ["cells_total", total],
        ["cells_answered", found],
        ["cells_not_found", total - found],
        ["flags_total", len(flagged)],
        ["flags_by_legal_risk", risk_text],
        ["note", f"{NOT_FOUND} = not found in the document; never fabricated"],
        ["note", "Verified column is for human sign-off only"],
        ["note", "no confidence-percentage columns (hard rule)"],
    ]
    write_csv(outdir / "_summary.csv", ["key", "value"], rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rows", required=True, type=Path, help="input JSON grid")
    parser.add_argument("--outdir", required=True, type=Path, help="CSV output dir")
    args = parser.parse_args()
    try:
        docs, questions, cells = load_grid(args.rows)
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        sys.exit(f"error: cannot load {args.rows}: {exc}")
    args.outdir.mkdir(parents=True, exist_ok=True)
    write_review(args.outdir, docs, questions, cells)
    flagged = write_flags(args.outdir, questions, cells)
    write_schema(args.outdir, questions)
    write_summary(args.outdir, docs, questions, cells, flagged)
    for name in ("review.csv", "flags.csv", "_schema.csv", "_summary.csv"):
        print(f"wrote {args.outdir / name}")


if __name__ == "__main__":
    main()
