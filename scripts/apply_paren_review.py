"""검토한 review_parens.csv 를 overrides.csv 에 반영한다.

1) python scripts/build_dict.py  → data/review/review_parens.csv 생성
2) 엑셀 등으로 열어 paren_types 열을 확인·수정하고, 확인한 행의 reviewed 를 yes 로 바꿔 저장
   (값: optional/alternative/annotation 또는 생략/대체/주석, 여러 개는 ; 구분)
3) python scripts/apply_paren_review.py [검토파일]  → overrides.csv 갱신 후 다시 빌드
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OV = ROOT / "data" / "overrides.csv"
FIELDS = ["id", "paren_types", "ko_forms", "en_fix", "en_alias", "source_note", "memo"]
PT = {"생략": "optional", "대체": "alternative", "주석": "annotation",
      "optional": "optional", "alternative": "alternative", "annotation": "annotation"}


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "review" / "review_parens.csv"
    rows = {}
    if OV.exists():
        with OV.open(encoding="utf-8-sig", newline="") as f:
            rows = {r["id"]: r for r in csv.DictReader(f) if r.get("id")}
    n, bad = 0, []
    with src.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if (r.get("reviewed") or "").strip().lower() not in ("yes", "y", "예", "o"):
                continue
            if not r["id"].startswith("r"):
                continue  # 추가 항목은 편집 기록에서 관리
            try:
                types = [PT[t.strip()] for t in r["paren_types"].split(";") if t.strip()]
            except KeyError as ex:
                bad.append(f"{r['id']}: 알 수 없는 유형 {ex}")
                continue
            if len(types) != len([c for c in r["paren_contents"].split(";") if c]):
                bad.append(f"{r['id']}: 소괄호 {r['paren_contents']} 와 유형 개수가 다름")
                continue
            row = rows.setdefault(r["id"], {k: "" for k in FIELDS} | {"id": r["id"]})
            row["paren_types"] = ";".join(types)
            n += 1
    if bad:
        print("\n".join(bad))
        sys.exit("오류가 있어 overrides.csv를 바꾸지 않았습니다.")
    with OV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for k in sorted(rows):
            w.writerow({x: rows[k].get(x, "") for x in FIELDS})
    print(f"소괄호 유형 {n}건 반영 → {OV}")


if __name__ == "__main__":
    main()
