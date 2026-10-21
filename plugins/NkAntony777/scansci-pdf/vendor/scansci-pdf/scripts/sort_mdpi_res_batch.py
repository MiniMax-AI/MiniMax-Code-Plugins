#!/usr/bin/env python3
"""Batch-download MDPI open-access PDFs from mdpi-res.com CDN.

`www.mdpi.com/pdf` blocks scripts (Cloudflare TLS fingerprinting), but the CDN is
open and URLs are constructible from the DOI:

    https://mdpi-res.com/d_attachment/{slug}/{slug}-{vol:02d}-{art:05d}/article_deploy/{same}[-v2|-v3|-v4].pdf

- slug = full journal name, NOT the DOI prefix (su -> sustainability, w -> water)
- filename has no issue number; volume zero-padded to 2, article number to 5
- sequential + throttle: hammering mdpi-res triggers a temporary IP block (SSL EOF)

Usage: python sort_mdpi_res_batch.py dois.txt --out pdfs/ [--resume log.jsonl]
"""
import argparse
import json
import re
import time
from pathlib import Path
import requests
from scansci_pdf.security import strict_mode, workspace_path, atomic_binary_writer, public_session

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
SLUGMAP = {
    "su": ["sustainability"], "atmos": ["atmosphere"], "w": ["water"], "f": ["forests"],
    "app": ["appliedsciences", "appchem", "app"], "s": ["software", "s"],
    "min": ["minerals"], "pr": ["proteomes", "practices", "pr"], "en": ["energies"],
    "polym": ["polymers"], "applbiosci": ["appliedbiosciences", "applbiosci"],
}


def variants(doi):
    m = re.match(r"^10\.3390/([a-z]+)(\d{6,})$", doi)
    if not m or len(m.group(2)) < 6:
        return []
    pref, d = m.groups()
    slugs = SLUGMAP.get(pref, [pref])
    out = []
    for voltake in (2, 1):  # 1-digit volumes exist on older journals (minerals-09-...)
        if len(d) <= voltake + 2:
            continue
        vol = str(int(d[:voltake])).zfill(2)
        art = str(int(d[voltake + 2:])).zfill(5)
        for slug in slugs:
            base = f"{slug}-{vol}-{art}"
            out += [f"https://mdpi-res.com/d_attachment/{slug}/{base}/article_deploy/"
                    f"{base}{suffix}.pdf" for suffix in ("", "-v2", "-v3", "-v4")]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dois", help="text file, one DOI per line")
    ap.add_argument("--out", default="pdfs", help="output directory")
    ap.add_argument("--resume", default="mdpi_res_log.jsonl")
    ap.add_argument("--sleep", type=float, default=0.4)
    a = ap.parse_args()
    if not strict_mode():
        ap.error('Run this helper through run_secure.py --helper')
    a.dois = str(workspace_path(a.dois))

    outdir = workspace_path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    done = set()
    log = workspace_path(a.resume)
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            try:
                done.add(json.loads(line)["doi"])
            except Exception:
                pass
    dois = [d.strip() for d in Path(a.dois).read_text(encoding="utf-8").splitlines()
            if d.strip()]
    todo = [d for d in dois
            if d not in done
            and not (outdir / (re.sub(r"[^\w.\-]", "_", d) + ".pdf")).exists()]
    print(f"todo={len(todo)}/{len(dois)}", flush=True)

    ok = 0
    with log.open("a", encoding="utf-8") as lf, public_session() as session:
        for doi in todo:
            path = outdir / (re.sub(r"[^\w.\-]", "_", doi) + ".pdf")
            hit = False
            for url in variants(doi):
                try:
                    with session.get(url, headers={'User-Agent': UA}, stream=True, timeout=(5, 15)) as response:
                        response.raise_for_status()
                        chunks, total = [], 0
                        deadline = time.monotonic() + 60
                        for chunk in response.iter_content(65536):
                            total += len(chunk)
                            if total > 32 * 1024 * 1024 or time.monotonic() > deadline:
                                raise ValueError('PDF exceeds size/time limit')
                            chunks.append(chunk)
                        data = b''.join(chunks)
                    if data[:5] == b"%PDF-":
                        with atomic_binary_writer(path) as output:
                            output.write(data)
                        ok += 1
                        hit = True
                        print(f"OK {doi} {len(data) // 1024}KB", flush=True)
                        break  # got the PDF — no need for further suffixes
                    # 200 but not a PDF (HTML error page): wrong candidate,
                    # fall through and try the next suffix/variant
                except requests.HTTPError as e:
                    if e.response.status_code == 404:
                        time.sleep(0.1)
                        continue
                    print(f"HTTP{e.response.status_code} {doi}", flush=True)
                    break
                except requests.RequestException as e:
                    print(f"COOLDOWN {doi} {type(e).__name__}", flush=True)
                    time.sleep(600)
                    break
                except Exception as e:
                    print(f"ERR {doi} {e}", flush=True)
                    break
            if not hit:
                print(f"MISS {doi}", flush=True)
            lf.write(json.dumps({"doi": doi, "status": "ok" if hit else "miss"}) + "\n")
            lf.flush()
            time.sleep(a.sleep)
    print(f"DONE recovered={ok} total_files={len(list(outdir.glob('*.pdf')))}", flush=True)


if __name__ == "__main__":
    main()
