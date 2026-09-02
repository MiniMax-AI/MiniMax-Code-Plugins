#!/usr/bin/env python3
"""Build an ASCII epidemic curve and summary stats from a case linelist CSV.

Pure stdlib. The linelist must contain an onset-date column (default
`onset_date`); an optional case-type column (default `case_type`) is used
for stratified counts. With --group-by and --population it also prints an
attack-rate table per group. Use --format json for machine-readable output.
"""

import argparse
import csv
import json
import sys
from collections import Counter
from datetime import datetime, timedelta

DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d")


def parse_date(raw):
    """Parse one date string against the supported formats."""
    text = (raw or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError("unparseable date: %r" % raw)


def week_start(day):
    """Return the Monday of the week containing the given date."""
    return day - timedelta(days=day.weekday())


def load_linelist(path, date_col, type_col):
    """Read the linelist CSV; return (cases, by_type, skipped).

    Each case is a (bucket_date, case_type, row_dict) triple. Rows with a
    blank or unparseable onset date are counted as skipped, not fatal.
    """
    cases, by_type, skipped = [], Counter(), 0
    try:
        fh = open(path, newline="", encoding="utf-8-sig")
    except OSError as exc:
        sys.exit(f"error: cannot read {path}: {exc}")
    with fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None or date_col not in reader.fieldnames:
            sys.exit("error: column %r not found in %s (columns: %s)"
                     % (date_col, path, reader.fieldnames))
        has_type = type_col in reader.fieldnames
        for row in reader:
            try:
                onset = parse_date(row.get(date_col))
            except ValueError:
                skipped += 1
                continue
            case_type = (row.get(type_col) or "").strip() if has_type else ""
            cases.append((onset, case_type, row))
            by_type[case_type or "(untyped)"] += 1
    if not cases:
        sys.exit("error: no usable rows (check the %r column)" % date_col)
    return cases, by_type, skipped


def aggregate(cases, interval):
    """Aggregate cases into a continuous daily/weekly bucket series."""
    counts = Counter()
    for onset, _, _ in cases:
        bucket = week_start(onset) if interval == "week" else onset
        counts[bucket] += 1
    first, last = min(counts), max(counts)
    step = timedelta(days=7 if interval == "week" else 1)
    series, day = [], first
    while day <= last:
        series.append((day, counts.get(day, 0)))
        day += step
    return series


def parse_population(spec):
    """Parse --population: either 'N' (shared denominator) or 'A=500,B=300'."""
    if spec is None:
        return None
    spec = spec.strip()
    try:
        if "=" not in spec:
            return {"*": int(spec)}
        table = {}
        for part in spec.split(","):
            key, _, value = part.partition("=")
            table[key.strip()] = int(value)
        return table
    except ValueError:
        sys.exit("error: --population must be an integer or 'A=500,B=300' form")


def attack_rates(cases, group_col, population):
    """Compute one attack-rate row per group value."""
    counts = Counter()
    for _, _, row in cases:
        counts[(row.get(group_col) or "").strip() or "(blank)"] += 1
    rows = []
    for group in sorted(counts):
        pop = population.get(group, population.get("*"))
        entry = {"group": group, "cases": counts[group], "population": pop}
        if pop:
            entry["attack_rate_pct"] = round(100.0 * counts[group] / pop, 2)
        else:
            entry["attack_rate_pct"] = None
            entry["note"] = "no denominator for this group"
        rows.append(entry)
    return rows


def ascii_curve(series, width):
    """Render the bucket series as text bars scaled to the peak count."""
    peak = max((n for _, n in series), default=0)
    lines = []
    for day, n in series:
        bar = "#" * (round(width * n / peak) if peak else 0)
        lines.append("%s | %-50s %d" % (day.isoformat(), bar, n))
    return lines


def main():
    # Windows consoles often default to GBK; force UTF-8 to never crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("linelist", help="case linelist CSV path")
    ap.add_argument("--date-col", default="onset_date", help="onset date column")
    ap.add_argument("--type-col", default="case_type", help="case type column")
    ap.add_argument("--interval", choices=["day", "week"], default="day")
    ap.add_argument("--group-by", help="column for an attack-rate table")
    ap.add_argument("--population",
                        help="denominator: 'N' or per-group 'A=500,B=300'")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--width", type=int, default=50, help="max ASCII bar width")
    args = ap.parse_args()

    cases, by_type, skipped = load_linelist(
        args.linelist, args.date_col, args.type_col)
    series = aggregate(cases, args.interval)
    peak_count = max(n for _, n in series)
    peak_date = next(d for d, n in series if n == peak_count)
    rates = None
    if args.group_by:
        if args.population is None:
            sys.exit("error: --group-by requires --population")
        if any(args.group_by not in row for _, _, row in cases):
            sys.exit("error: column %r missing in some rows" % args.group_by)
        rates = attack_rates(cases, args.group_by,
                             parse_population(args.population))

    stats = {
        "input": args.linelist,
        "interval": args.interval,
        "total": len(cases),
        "peak_date": peak_date.isoformat(),
        "peak_count": peak_count,
        "span": {"start": series[0][0].isoformat(),
                 "end": series[-1][0].isoformat(),
                 "days": (series[-1][0] - series[0][0]).days + 1},
        "by_type": dict(sorted(by_type.items())),
        "skipped_rows": skipped,
        "curve": [{"bucket": d.isoformat(), "count": n} for d, n in series],
    }
    if rates is not None:
        stats["attack_rates"] = rates

    if args.format == "json":
        json.dump(stats, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return

    print("# epidemic curve (%s buckets), n=%d" % (args.interval, stats["total"]))
    for line in ascii_curve(series, args.width):
        print(line)
    print("\n# summary")
    print("total        : %d" % stats["total"])
    print("peak         : %s (%d cases)" % (stats["peak_date"], peak_count))
    print("span         : %(start)s .. %(end)s (%(days)d days)" % stats["span"])
    print("by_type      : %s" % json.dumps(stats["by_type"], ensure_ascii=False))
    print("skipped_rows : %d" % skipped)
    if rates is not None:
        print("\n# attack rates by %s" % args.group_by)
        print("%-16s %6s %12s %16s" % ("group", "cases", "population", "attack_rate%"))
        for r in rates:
            pct = "%.2f" % r["attack_rate_pct"] if r["attack_rate_pct"] is not None else "n/a"
            print("%-16s %6d %12s %16s" % (
                r["group"], r["cases"], r["population"] or "n/a", pct))


if __name__ == "__main__":
    main()
