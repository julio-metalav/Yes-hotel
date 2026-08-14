"""
Extrai texto tabular dos PDFs HITS/Omnibees para JSON em tmp/.
Não commitar PDFs nem este JSON extraído (PII de nomes).
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

try:
    import fitz
except ImportError:
    print("pymupdf é obrigatório para extrair os PDFs.", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "tmp" / "management-import"
OUT_DIR = SRC_DIR / "extracted"

MONEY_RE = re.compile(r"^-?\$?\d{1,3}(?:\.\d{3})*,\d{2}$")
DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{2,4}$")
PAX_RE = re.compile(r"^\d+/\d+/\d+/\d+$")
ACCT_RE = re.compile(r"^#\d+-\d+$")
TIPOS = {"Regular", "Early ck-in", "Late ck-out", "No show", "Cortesia"}
OPS = {"L", "E"}

def hits_files(src_dir: Path) -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = []
    for path in sorted(src_dir.glob("Hits*.pdf")):
        name = path.name.lower()
        if "julho" in name:
            found.append((path, "hits_jul"))
        elif "abril" in name or "jun" in name:
            found.append((path, "hits_apr_jun"))
        elif "jan" in name or "mar" in name:
            found.append((path, "hits_jan_mar"))
        else:
            found.append((path, path.stem))
    return found


def flatten_cells(row) -> list[str]:
    out = []
    for cell in row:
        if cell is None:
            continue
        text = str(cell).replace("\n", " ").strip()
        if text:
            out.append(text)
    return out


def parse_hits_row(cells: list[str], source: str) -> dict | None:
    if len(cells) < 10:
        return None
    if cells[0] in ("Data",) or cells[0].startswith("Auditoria") or cells[0].startswith("YES"):
        return None
    if cells[0] == "Subtotal" or cells[0].startswith("Resumo") or cells[0].startswith("Filtros"):
        return None
    if not DATE_RE.match(cells[0]):
        return None
    if cells[1] not in OPS:
        return None
    tipo = None
    for c in cells:
        if c in TIPOS:
            tipo = c
            break
    if not tipo:
        return None
    moneys = [c for c in cells if MONEY_RE.match(c.replace(" ", ""))]
    if len(moneys) < 3:
        return None
    dates = [c for c in cells if DATE_RE.match(c)]
    accts = [c for c in cells if ACCT_RE.match(c)]
    pax = next((c for c in cells if PAX_RE.match(c)), None)
    skip = {cells[0], cells[1], tipo, *moneys, *dates, *accts}
    if pax:
        skip.add(pax)
    skip.update({"COMCAFE", "SEMCAFE", "CM", "Nenhum"})
    guest_parts = []
    for c in cells[2:]:
        if c in skip:
            continue
        if c.startswith("00") and "(" in c:
            continue
        if re.match(r"^\d{3}\s*\(", c):
            continue
        guest_parts.append(c)
    guest = " ".join(guest_parts).strip()
    apto = next((c for c in cells if re.match(r"^\d{3}\b", c)), "")
    audit = dates[0]
    stay_in = dates[1] if len(dates) > 1 else None
    stay_out = dates[2] if len(dates) > 2 else None
    return {
        "sourceFile": source,
        "auditDate": audit,
        "op": cells[1],
        "room": apto,
        "tipo": tipo,
        "diaria": moneys[0],
        "ab": moneys[1],
        "diariaAb": moneys[2],
        "guestRaw": guest,
        "pax": pax,
        "stayIn": stay_in,
        "stayOut": stay_out,
        "accountOrigin": accts[0] if accts else None,
        "account": accts[1] if len(accts) > 1 else (accts[0] if accts else None),
    }


def extract_hits(path: Path, source: str) -> list[dict]:
    doc = fitz.open(path)
    rows: list[dict] = []
    for page in doc:
        found = page.find_tables()
        if not found:
            continue
        for table in found.tables:
            for raw in table.extract():
                parsed = parse_hits_row(flatten_cells(raw), source)
                if parsed:
                    rows.append(parsed)
    return rows


OMNI_COLS = [
    ("res_no", 0, 88),
    ("estado", 88, 130),
    ("booked_at", 130, 175),
    ("checkin", 175, 218),
    ("checkout", 218, 262),
    ("guest", 262, 338),
    ("channel", 338, 428),
    ("los", 428, 454),
    ("ad", 454, 476),
    ("ch", 476, 492),
    ("room", 492, 578),
    ("rate", 578, 688),
    ("extras", 688, 720),
    ("pesp", 720, 768),
    ("total", 768, 860),
]

HEADER_NOISE = {
    "Res.",
    "Nº",
    "No",
    "Estado",
    "Data",
    "Check",
    "In",
    "Out",
    "Hóspede",
    "Hospede",
    "Canal/A.V./Empresa",
    "LOS",
    "Ad",
    "Ch",
    "Apartamento",
    "Tarifa",
    "Extras",
    "P.",
    "Esp.",
    "Total",
    "|",
}


def col_of(x: float) -> str | None:
    for name, a, b in OMNI_COLS:
        if a <= x < b:
            return name
    return None


def clean_tokens(tokens: list[str]) -> str:
    cleaned = [t for t in tokens if t not in HEADER_NOISE]
    return " ".join(cleaned).strip()


def extract_omnibees(path: Path) -> list[dict]:
    doc = fitz.open(path)
    rows: list[dict] = []
    for page_index, page in enumerate(doc):
        words = page.get_text("words")
        min_y = 250 if page_index == 0 else 40
        anchors = sorted(
            w[1]
            for w in words
            if w[4] in {"Confirmada", "Cancelada"} and 88 <= w[0] < 130 and w[1] > min_y
        )
        buckets: dict[float, dict[str, list[str]]] = {
            a: defaultdict(list) for a in anchors
        }
        for w in words:
            y, x, token = w[1], w[0], w[4]
            best = None
            best_d = 99.0
            col = col_of(x)
            if col is None:
                continue
            limit = 10 if col in {"estado", "channel", "booked_at", "checkin", "checkout", "total", "los"} else 20
            for a in anchors:
                d = abs(y - a)
                if d < best_d:
                    best_d = d
                    best = a
            if best is None or best_d > limit:
                continue
            buckets[best][col].append(token)
        for y, cols in buckets.items():
            rec = {k: clean_tokens(v) for k, v in cols.items()}
            rec["page"] = page_index + 1
            if rec.get("estado") in {"Confirmada", "Cancelada"}:
                rows.append(rec)
    return rows


def main() -> int:
    hits_pdfs = hits_files(SRC_DIR)
    omni = SRC_DIR / "Omnibees.pdf"
    if len(hits_pdfs) < 3 or not omni.exists():
        print("PDFs ausentes em tmp/management-import/. Esperados 3 HITS + Omnibees.pdf", file=sys.stderr)
        print("encontrados:", [p.name for p, _ in hits_pdfs], omni.exists(), file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    hits_all: list[dict] = []
    for path, source in hits_pdfs:
        print(f"Extraindo HITS {path.name}...", flush=True)
        part = extract_hits(path, source)
        print(f"  {len(part)} linhas")
        hits_all.extend(part)

    print("Extraindo Omnibees...", flush=True)
    omni_rows = extract_omnibees(omni)
    print(f"  {len(omni_rows)} linhas")

    (OUT_DIR / "hits-rows.json").write_text(
        json.dumps(hits_all, ensure_ascii=False, indent=0),
        encoding="utf-8",
    )
    (OUT_DIR / "omnibees-rows.json").write_text(
        json.dumps(omni_rows, ensure_ascii=False, indent=0),
        encoding="utf-8",
    )
    print(f"OK hits={len(hits_all)} omnibees={len(omni_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
