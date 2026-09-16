"""PRD 8장 수용 기준 자동 검증.  실행: python scripts/test_build.py [--strict]"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_dict as B  # noqa: E402
from dictcore import ExpandError, choseong, compact_key, en_key, expand_ko, normalize_en  # noqa: E402

ROOT = B.ROOT
FAILS: list[str] = []


def check(ok, msg):
    print(("  ok  " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


class Dict:
    """테스트용 검색기 (web/app.js 검색 규칙의 간이판)."""

    def __init__(self, doc):
        self.e = {x["id"]: x for x in doc["entries"]}
        self.doc = doc

    def active(self):
        return [x for x in self.e.values() if x.get("status") != "deleted"]

    def en(self, q):
        k = compact_key(q)
        out = []
        for x in self.active():
            keys = [x["en"], *x.get("en_variants", []), *x.get("abbr", []), *x.get("en_alias", [])]
            if any(compact_key(s).startswith(k) for s in keys):
                out.append(x)
        return out

    def en_exact(self, q):
        return [x for x in self.active() if compact_key(x["en"]) == compact_key(q)
                or compact_key(q) in map(compact_key, x.get("abbr", []) + x.get("en_alias", []))]

    def ko(self, q):
        return [x for x in self.active() if q in x["ko_forms"]]

    def cho(self, q):
        return [x for x in self.active() if any(choseong(f).replace(" ", "") == q for f in x["ko_forms"])]


def run_build(edits, tmp: Path):
    ep = tmp / "edits.json"
    ep.write_text(json.dumps({"edits": edits}, ensure_ascii=False), encoding="utf-8")
    out = tmp / "dict.json"
    doc = B.build(B.DATA / "용어집.xlsx", B.DATA / "overrides.csv", ep, out, tmp / "review")
    return doc, out


def ed(i, op, tid, after=None, before=None, reason="테스트"):
    return {"edit_id": f"t{i:03d}", "op": op, "target_id": tid, "after": after or {},
            "before": before or {}, "reason": reason, "editor": "test",
            "created_at": f"2026-09-15T10:{i:02d}:00+09:00", "status": "approved"}


def main(strict=False):
    src = B.DATA / "용어집.xlsx"
    h0 = B.sha256(src)
    tmp = Path(tempfile.mkdtemp())
    try:
        print("[1-2] 원천 반영·왕복 도달")
        doc, out = run_build([], tmp)
        d = Dict(doc)
        m = doc["meta"]
        check(m["rows"] == 5059 and m["entries"] == 5059, f"유효 행 5059 (실제 {m['rows']})")
        ids_en = {i for v in doc["index_en"].values() for i in v}
        ids_ko = {i for v in doc["index_ko"].values() for i in v}
        check(ids_en == ids_ko == set(d.e), "모든 항목이 영한·한영 색인에서 도달 가능")

        print("[3] 소괄호 검토")
        msg = f"소괄호 미검토 {m['paren_unreviewed']}건 (data/review/review_parens.csv)"
        if strict:
            check(m["paren_unreviewed"] == 0, msg)
        else:
            print("  info " + msg)

        print("[4] 대표 검색 사례")
        forms = {f for x in d.en_exact("likelihood ratio test") for f in x["ko_forms"]}
        check({"가능도비 검정", "우도비 검정", "가능도비 검증", "우도비 검증"} <= forms, "likelihood ratio test")
        check(any(x["en"] == "likelihood ratio test" for x in d.ko("우도비 검증")), "우도비 검증 → likelihood ratio test")
        senses = {(x.get("sense"), x["ko_primary"]) for x in d.en_exact("power")}
        check({1, 2} <= {s for s, _ in senses}, f"power 의미 구분 {senses}")
        check(any("제한최대가능도" in x["ko_forms"] for x in d.en_exact("REML")), "REML → 제한최대가능도")
        cp = {f for x in d.en_exact("change point") for f in x["ko_forms"]}
        check({"변화시점", "변화점", "전환점"} <= cp, "change point")
        check(any("레비 과정" in x["ko_forms"] for x in d.en_exact("Levy process")), "Levy process → 레비 과정")
        check(any(x["ko_primary"] == "결정계수" for x in d.cho("ㄱㅈㄱㅅ")), "초성 ㄱㅈㄱㅅ → 결정계수")
        check(any(x["en"] == "Gauss-Jordan elimination" for x in d.en("gauss jordan")), "gauss jordan 접두 검색")
        check(any(x["id"] == "r0290" for x in d.en_exact("hierarchical Bayes model")), "철자 교정 별칭 검색")

        print("[5] 원천 파일 불변")
        check(B.sha256(src) == h0, "용어집.xlsx 해시 동일")

        print("[6] 추가")
        add = ed(1, "add", "u0001", {"ko_raw": "등각예측, 컨포멀 예측", "en_raw": "conformal prediction"})
        doc, _ = run_build([add], tmp)
        d = Dict(doc)
        check(any(x["id"] == "u0001" for x in d.en("conformal prediction")), "conformal prediction 검색")
        check(any(x["id"] == "u0001" for x in d.ko("컨포멀 예측")), "컨포멀 예측 검색")
        check(d.e["u0001"]["status"] == "added" and d.e["u0001"].get("src_row") is None, "상태 added, src_row 없음")

        print("[7] 수정")
        upd = ed(2, "update", "r0003", {"ko_raw": "가능도, 라이클리후드"},
                 before={"ko_raw": "가능도, 우도", "en_raw": "likelihood"})
        doc, _ = run_build([add, upd], tmp)
        d = Dict(doc)
        check(not any(x["id"] == "r0003" for x in d.ko("우도")), "이전 표기(우도)로 검색 안 됨")
        check(any(x["id"] == "r0003" for x in d.ko("라이클리후드")), "새 표기로 검색됨")
        check(d.e["r0003"]["status"] == "updated" and d.e["r0003"]["original"]["ko_raw"] == "가능도, 우도",
              "상태 updated, 원문 보존")

        print("[8] 삭제·복원")
        dele = ed(3, "delete", "u0001", reason="중복")
        doc, _ = run_build([add, upd, dele], tmp)
        d = Dict(doc)
        check(not d.en("conformal prediction") and "u0001" not in {i for v in doc["index_en"].values() for i in v},
              "삭제 후 검색·색인 제외")
        check(d.e["u0001"]["status"] == "deleted", "소프트 삭제(항목 보존)")
        res = ed(4, "restore", "u0001")
        doc, _ = run_build([add, upd, dele, res], tmp)
        d = Dict(doc)
        check(d.e["u0001"]["status"] == "added" and d.en("conformal prediction"), "복원 후 원래 상태")
        dup = ed(5, "add", "u0001", {"ko_raw": "다른 용어", "en_raw": "other"})
        doc, _ = run_build([add, dele, dup], tmp)
        check(doc["meta"]["conflicts"] == 1, "삭제된 id 재사용 시 충돌")

        print("[9] 재현성·충돌")
        edits = [add, upd, dele, res]
        _, o1 = run_build(edits, tmp)
        b1 = o1.read_bytes()
        _, o2 = run_build(list(reversed(edits)), tmp)
        check(b1 == o2.read_bytes(), "같은 입력 → 같은 dict.json (편집 파일 순서 무관)")
        bad = ed(6, "update", "r0004", {"ko_raw": "x"}, before={"ko_raw": "틀린 값"})
        doc, _ = run_build([bad], tmp)
        rc = (tmp / "review" / "review_conflicts.csv").read_text(encoding="utf-8-sig")
        check(doc["meta"]["conflicts"] == 1 and "t006" in rc, "before 불일치 → 미적용 + review_conflicts.csv")
        inval = ed(7, "add", "u0002", {"ko_raw": "가[나", "en_raw": "x"})
        doc, _ = run_build([inval], tmp)
        check(doc["meta"]["conflicts"] == 1 and "u0002" not in Dict(doc).e, "괄호 오류 편집은 적용 안 됨")
        draft = dict(ed(8, "add", "u0003", {"ko_raw": "초안", "en_raw": "draft"}), status="draft")
        doc, _ = run_build([draft], tmp)
        check("u0003" not in Dict(doc).e, "draft 편집은 빌드에 미반영")

        print("[10] 공통 전개 사례 (Python)")
        cases = json.loads((ROOT / "tests" / "expansion_cases.json").read_text(encoding="utf-8"))
        bad = 0
        for c in cases["ko"]:
            try:
                r = expand_ko(c["raw"], c.get("paren_types"), strict=True)
                ok = not c.get("error") and r["forms"] == c["forms"] \
                    and r["notes"] == c.get("notes", r["notes"]) \
                    and [p["type"] for p in r["parens"]] == c.get("paren", [p["type"] for p in r["parens"]])
            except ExpandError:
                ok = bool(c.get("error"))
            bad += not ok
            if not ok:
                print("    불일치:", c["raw"])
        for c in cases["en"]:
            try:
                r = normalize_en(c["raw"])
                ok = not c.get("error") and all(r[k] == c[k] for k in ("en", "variants", "abbr", "sense")) \
                    and compact_key(r["en"]) == c["compact"]
            except ExpandError:
                ok = bool(c.get("error"))
            bad += not ok
            if not ok:
                print("    불일치:", c["raw"])
        bad += sum(choseong(s) != w for s, w in cases["choseong"])
        check(bad == 0, "Python 공통 사례 전부 일치")
        _ = en_key  # noqa

        print("[10] JS 공통 사례 + 전수 비교 (Node)")
        B.build(src, B.DATA / "overrides.csv", B.DATA / "edits.json",
                ROOT / "web" / "data" / "dict.json", B.DATA / "review")
        if shutil.which("node"):
            p = subprocess.run(["node", str(ROOT / "tests" / "test_core.js")], capture_output=True, text=True)
            print("    " + p.stdout.strip().replace("\n", "\n    "))
            check(p.returncode == 0, "JS 결과가 Python과 일치")
        else:
            print("  skip node가 없어 JS 검사를 건너뜀")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("모든 검사 통과" if not FAILS else f"실패 {len(FAILS)}건")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main(strict="--strict" in sys.argv)
