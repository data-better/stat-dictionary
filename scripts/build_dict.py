"""용어집.xlsx + overrides.csv + edits.json → web/data/dict.json

사용법:
    python scripts/build_dict.py            # 기본 경로
    python scripts/build_dict.py --strict   # 소괄호 미검토·충돌이 있으면 실패(배포 전)
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from dictcore import apply_edits, build_entry, compact_entry, en_key, expand_ko  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def load_source(path: Path):
    df = pd.read_excel(path, dtype=str)
    df = df.iloc[:, :2]
    df.columns = ["ko", "en"]
    rows, seen, dropped = [], set(), {"empty": 0, "duplicate": 0}
    for i, (ko, en) in enumerate(df.itertuples(index=False), start=1):
        ko = (ko or "").strip() if isinstance(ko, str) else ""
        en = (en or "").strip() if isinstance(en, str) else ""
        if not ko or not en:
            dropped["empty"] += 1
            continue
        if (ko, en) in seen:
            dropped["duplicate"] += 1
            continue
        seen.add((ko, en))
        rows.append((i, ko, en))
    return rows, len(df), dropped


def split_list(v, sep):
    return [x.strip() for x in (v or "").split(sep) if x.strip()]


def load_overrides(path: Path):
    """열: id, paren_types(;구분), ko_forms(|구분), en_fix, en_alias(|구분), source_note, memo"""
    out = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if not (r.get("id") or "").strip():
                continue
            out[r["id"].strip()] = {
                "paren_types": split_list(r.get("paren_types"), ";") or None,
                "ko_forms": split_list(r.get("ko_forms"), "|") or None,
                "en_fix": (r.get("en_fix") or "").strip() or None,
                "en_alias": split_list(r.get("en_alias"), "|"),
                "source_note": (r.get("source_note") or "").strip() or None,
            }
    return out


def load_edits(path: Path):
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8") or "[]")
    return data.get("edits", data) if isinstance(data, dict) else data


def write_csv(path: Path, header, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def build(src: Path, overrides_path: Path, edits_path: Path, out: Path, review_dir: Path):
    rows, total, dropped = load_source(src)
    ov = load_overrides(overrides_path)
    entries = {}
    for src_row, ko, en in rows:
        eid = f"r{src_row:04d}"
        o = ov.get(eid, {})
        entries[eid] = build_entry(eid, src_row, ko, en, o.get("paren_types"), o.get("ko_forms"),
                                   o.get("en_fix"), o.get("en_alias"), o.get("source_note"))
    unknown_ov = sorted(set(ov) - set(entries))

    edits = load_edits(edits_path)
    entries, conflicts, applied = apply_edits(entries, edits, only_approved=True)

    # 검토 리포트 ----------------------------------------------------------
    paren_rows, bracket_rows = [], []
    for e in entries.values():
        if e["status"] == "deleted":
            continue
        if "(" in e["ko_raw"]:
            info = expand_ko(e["ko_raw"], e.get("paren_types"))
            if info["parens"]:
                paren_rows.append([
                    e["id"], e["ko_raw"], e["en"],
                    ";".join(p["content"] for p in info["parens"]),
                    ";".join(p["type"] for p in info["parens"]),
                    "no" if "paren_unreviewed" in e["flags"] else "yes",
                    " | ".join(e["ko_forms"])])
        if "[" in e["ko_raw"]:
            bracket_rows.append([e["id"], e["ko_raw"], e["en"], " | ".join(e["ko_forms"]),
                                 ";".join(e["flags"])])
    review_dir.mkdir(parents=True, exist_ok=True)
    write_csv(review_dir / "review_parens.csv",
              ["id", "ko_raw", "en", "paren_contents", "paren_types", "reviewed", "ko_forms"], paren_rows)
    write_csv(review_dir / "review_brackets.csv",
              ["id", "ko_raw", "en", "ko_forms", "flags"], bracket_rows)
    write_csv(review_dir / "review_conflicts.csv",
              ["edit_id", "op", "target_id", "reason"],
              [[c["edit_id"], c["op"], c["target_id"], c["reason"]] for c in conflicts])

    # 색인 (삭제 제외) -----------------------------------------------------
    index_en, index_ko = {}, {}
    ordered = sorted(entries.values(), key=lambda e: (e["src_row"] is None, e["src_row"] or 0, e["id"]))
    for e in ordered:
        if e["status"] == "deleted":
            continue
        key = en_key(e["en"]) + (f"#{e['sense']}" if e.get("sense") else "")
        index_en.setdefault(key, []).append(e["id"])
        for f in e["ko_forms"]:
            index_ko.setdefault(f, []).append(e["id"])

    active = [e for e in ordered if e["status"] != "deleted"]
    status_count = {}
    for e in ordered:
        status_count[e["status"]] = status_count.get(e["status"], 0) + 1
    meta = {
        "source": "한국통계학회 통계용어",
        "source_file": src.name,
        "source_sha256": sha256(src),
        "edits_sha256": hashlib.sha256(json.dumps(
            sorted(edits, key=lambda x: (x.get("created_at", ""), x.get("edit_id", ""))),
            ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "overrides_sha256": sha256(overrides_path),
        "source_rows": total,
        "dropped": dropped,
        "rows": len(rows),
        "entries": len(ordered),
        "active_entries": len(active),
        "status_count": status_count,
        "edits_applied": len(applied),
        "applied_edit_ids": sorted(applied),
        "conflicts": len(conflicts),
        "paren_unreviewed": sum("paren_unreviewed" in e["flags"] for e in active),
        "unknown_override_ids": unknown_ov,
    }
    doc = {"meta": meta, "entries": [compact_entry(e) for e in ordered],
           "index_en": index_en, "index_ko": index_ko}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                   encoding="utf-8")
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DATA / "용어집.xlsx", type=Path)
    ap.add_argument("--overrides", default=DATA / "overrides.csv", type=Path)
    ap.add_argument("--edits", default=DATA / "edits.json", type=Path)
    ap.add_argument("--out", default=ROOT / "web" / "data" / "dict.json", type=Path)
    ap.add_argument("--review-dir", default=DATA / "review", type=Path)
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args()

    before = sha256(a.source)
    doc = build(a.source, a.overrides, a.edits, a.out, a.review_dir)
    assert sha256(a.source) == before, "원천 파일이 변경되었습니다"
    m = doc["meta"]
    print(f"원천 {m['source_rows']}행 → 유효 {m['rows']}행 (빈 행 {m['dropped']['empty']}, 중복 {m['dropped']['duplicate']})")
    print(f"항목 {m['entries']}개 (검색 대상 {m['active_entries']}), 상태 {m['status_count']}")
    print(f"편집 적용 {m['edits_applied']}건, 충돌 {m['conflicts']}건, 소괄호 미검토 {m['paren_unreviewed']}건")
    print(f"→ {a.out}  ({a.out.stat().st_size/1024:.0f} KB)")
    if m["unknown_override_ids"]:
        print("경고: overrides.csv에 없는 id:", ", ".join(m["unknown_override_ids"]))
    if a.strict and (m["conflicts"] or m["paren_unreviewed"]):
        sys.exit("strict 모드: 충돌 또는 소괄호 미검토 항목이 있습니다 (data/review/ 확인)")


if __name__ == "__main__":
    main()
