"""웹앱에서 내보낸 edits.json 을 data/edits.json 에 병합한다 (같은 edit_id 는 건너뜀).

  python scripts/merge_edits.py ~/Downloads/edits-20260915.json [--approve]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "data" / "edits.json"
FIELDS = ("edit_id", "op", "target_id", "before", "after", "reason", "editor", "created_at", "status")


def load(p: Path):
    d = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    return d.get("edits", []) if isinstance(d, dict) else d


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    cur = load(TARGET)
    ids = {e["edit_id"] for e in cur}
    added = 0
    for p in args:
        for e in load(Path(p)):
            if e.get("edit_id") in ids:
                continue
            e = {k: e.get(k) for k in FIELDS}
            if "--approve" in sys.argv:
                e["status"] = "approved"
            if e["op"] not in ("add", "update", "delete", "restore") or not e["target_id"]:
                print("건너뜀(형식 오류):", e.get("edit_id"))
                continue
            cur.append(e)
            ids.add(e["edit_id"])
            added += 1
    cur.sort(key=lambda x: (x.get("created_at") or "", x["edit_id"]))
    TARGET.write_text(json.dumps({"version": 1, "edits": cur}, ensure_ascii=False, indent=1), encoding="utf-8")
    drafts = sum(e.get("status") != "approved" for e in cur)
    print(f"{added}건 병합 → {TARGET} (총 {len(cur)}건, draft {drafts}건은 빌드에 반영되지 않음)")


if __name__ == "__main__":
    main()
