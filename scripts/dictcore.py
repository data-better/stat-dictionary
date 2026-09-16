"""통계용어 사전 공통 로직 (Python).

web/core.js 와 동일한 결과를 내야 한다. 규칙을 바꾸면 두 파일을 함께 고치고
tests/expansion_cases.json 으로 양쪽을 검증한다.
"""
from __future__ import annotations

import re
import unicodedata

MAX_FORMS = 8
HANJA_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")
CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
PAREN_TYPES = ("optional", "alternative", "annotation")


class ExpandError(ValueError):
    pass


# ---------------------------------------------------------------- 공통 유틸
def clean_space(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("\u00a0", " ")).strip()


def strip_marks(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def en_key(s: str) -> str:
    """영문 표제어 병합 키: 발음기호 제거, 소문자, 공백 1개."""
    return clean_space(strip_marks(s)).lower()


def compact_key(s: str) -> str:
    """검색 키: 영문자·숫자·한글만 남김 (log-linear == loglinear)."""
    return re.sub(r"[^0-9a-z\uac00-\ud7a3]", "", en_key(s))


def choseong(s: str) -> str:
    out = []
    for ch in s:
        code = ord(ch)
        if 0xAC00 <= code <= 0xD7A3:
            out.append(CHOSEONG[(code - 0xAC00) // 588])
        elif ch.strip():
            out.append(ch.lower())
    return "".join(out)


def _dedup(items):
    seen, out = set(), []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ---------------------------------------------------------------- 한글 전개
def check_balanced(s: str):
    stack = []
    pairs = {"]": "[", ")": "("}
    for ch in s:
        if ch in "[(":
            if stack:
                raise ExpandError("괄호 안에 괄호를 넣을 수 없습니다")
            stack.append(ch)
        elif ch in "])":
            if not stack or stack.pop() != pairs[ch]:
                raise ExpandError("괄호 짝이 맞지 않습니다")
    if stack:
        raise ExpandError("닫히지 않은 괄호가 있습니다")


def split_top(s: str):
    parts, buf, depth = [], [], 0
    for ch in s:
        if ch in "[(":
            depth += 1
        elif ch in "])":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return [clean_space(p) for p in parts if clean_space(p)]


def parse_segments(part: str):
    segs, i = [], 0
    while i < len(part):
        ch = part[i]
        if ch in "[(":
            close = "]" if ch == "[" else ")"
            j = part.index(close, i)
            content = part[i + 1 : j]
            segs.append(("alt" if ch == "[" else "paren", content))
            i = j + 1
        else:
            j = i
            while j < len(part) and part[j] not in "[(":
                j += 1
            segs.append(("text", part[i:j]))
            i = j
    return segs


def paren_kind(content: str) -> str | None:
    """자동 판별이 확실한 경우만 반환(annotation). 나머지는 None."""
    if HANJA_RE.search(content) or not HANGUL_RE.search(content):
        return "annotation"
    return None


def guess_paren(unit: str, content: str, next_char: str) -> str:
    if len(content) >= 2 and unit and (
        content[0] == unit[0] or (len(content) == len(unit) and HANGUL_RE.match(next_char or ""))
    ):
        return "alternative"
    return "optional"


def _unit(prefix: str) -> str:
    return prefix[prefix.rfind(" ") + 1 :]


def _common_prefix(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def replace_unit(prefix: str, alt: str) -> str:
    unit = _unit(prefix)
    head = prefix[: len(prefix) - len(unit)]
    if not unit:
        return prefix + alt
    if " " in alt or len(alt) >= len(unit) - 1 or _common_prefix(unit, alt) >= 1:
        return head + alt
    return head + unit[: len(unit) - len(alt)] + alt


def expand_ko(raw: str, paren_types=None, cap: int = MAX_FORMS, strict: bool = False):
    """한글 원문을 검색 가능한 표기 목록으로 전개한다.

    반환: dict(forms, notes, parens, flags)
      parens: 사용자 지정이 필요한 소괄호 목록 [{content, type, guessed}]
    """
    s = clean_space(raw)
    if not s:
        raise ExpandError("한글 용어가 비어 있습니다")
    try:
        check_balanced(s)
    except ExpandError:
        if strict:
            raise
        return {"forms": [s], "notes": [], "parens": [], "flags": ["unbalanced"]}

    paren_types = list(paren_types or [])
    notes, parens, flags = [], [], []
    forms = []
    for part in split_top(s):
        segs = parse_segments(part)
        prefixes = [""]
        for k, (kind, content) in enumerate(segs):
            content_c = clean_space(content)
            if kind == "text":
                prefixes = [p + content for p in prefixes]
            elif kind == "alt":
                alts = [a for a in (clean_space(x) for x in content.split(",")) if a]
                new = []
                for p in prefixes:
                    new.append(p)
                    new.extend(replace_unit(p, a) for a in alts)
                prefixes = new
            else:  # paren
                auto = paren_kind(content_c)
                if auto:
                    notes.append(content_c)
                    continue
                idx = len(parens)
                nxt = segs[k + 1][1][:1] if k + 1 < len(segs) and segs[k + 1][0] == "text" else ""
                given = paren_types[idx] if idx < len(paren_types) else None
                ptype = given or guess_paren(_unit(prefixes[0]), content_c, nxt)
                parens.append({"content": content_c, "type": ptype, "guessed": given is None})
                if ptype == "annotation":
                    notes.append(content_c)
                elif ptype == "alternative":
                    new = []
                    for p in prefixes:
                        new += [p, replace_unit(p, content_c)]
                    prefixes = new
                else:  # optional: 포함형을 먼저
                    new = []
                    for p in prefixes:
                        new += [p + content_c, p]
                    prefixes = new
        forms.extend(clean_space(p) for p in prefixes)

    forms = _dedup(forms)
    if len(forms) > cap:
        if strict:
            raise ExpandError(f"전개 결과가 {len(forms)}개로 상한({cap})을 넘습니다")
        forms = forms[:cap]
        flags.append("expansion_capped")
    for t in paren_types:
        if t not in PAREN_TYPES:
            raise ExpandError(f"알 수 없는 소괄호 유형: {t}")
    return {"forms": forms, "notes": _dedup(notes), "parens": parens, "flags": flags}


# ---------------------------------------------------------------- 영문 정규화
def normalize_en(raw: str, strict: bool = False):
    s = clean_space(raw)
    if not s:
        raise ExpandError("영문 용어가 비어 있습니다")
    abbr, sense = [], None
    m = re.search(r";\s*([^;]+)$", s)
    if m:
        abbr.append(clean_space(m.group(1)))
        s = s[: m.start()]
    m = re.search(r"\s*\((\d+)\)\s*$", s)
    if m:
        sense = int(m.group(1))
        s = s[: m.start()]

    def take(mm):
        inner = clean_space(mm.group(1))
        if len(re.findall(r"[A-Z]", inner)) >= 2:
            abbr.append(inner)
            return " "
        return mm.group(0)

    s = clean_space(re.sub(r"\s*\(([^()]*)\)", take, s))
    variants = _dedup(clean_space(x) for x in re.split(r"\s*[/,]\s*", s))
    if not variants:
        raise ExpandError("영문 용어가 비어 있습니다")
    return {"en": variants[0], "variants": variants[1:], "abbr": _dedup(abbr), "sense": sense}


# ---------------------------------------------------------------- 항목 생성
def build_entry(eid, src_row, ko_raw, en_raw, paren_types=None, ko_forms=None,
                en_fix=None, en_alias=None, source_note=None, definition=None,
                status="original", strict=False):
    ko = expand_ko(ko_raw, paren_types, strict=strict)
    en = normalize_en(en_fix or en_raw, strict=strict)
    flags = list(ko["flags"])
    if ko_forms:
        ko["forms"] = _dedup(clean_space(x) for x in ko_forms)
        flags.append("forms_overridden")
    if en_fix:
        flags.append("en_fixed")
    if any(p["guessed"] for p in ko["parens"]) and not ko_forms:
        flags.append("paren_unreviewed")
    e = {
        "id": eid,
        "src_row": src_row,
        "ko_raw": clean_space(ko_raw),
        "en_raw": clean_space(en_raw),
        "ko_forms": ko["forms"],
        "ko_primary": ko["forms"][0],
        "en": en["en"],
        "en_variants": en["variants"],
        "abbr": en["abbr"],
        "sense": en["sense"],
        "notes": ko["notes"],
        "paren_types": [p["type"] for p in ko["parens"]] if paren_types else None,
        "en_fix": en_fix,
        "en_alias": list(en_alias or []),
        "source_note": source_note,
        "definition": definition,
        "status": status,
        "flags": flags,
    }
    return e


def compact_entry(e):
    """None·빈 목록 필드를 제거해 JSON 크기를 줄인다."""
    return {k: v for k, v in e.items() if v not in (None, [], "")}


EDITABLE = ("ko_raw", "en_raw", "paren_types", "source_note", "definition")


def apply_edits(entries: dict, edits: list, only_approved: bool = True):
    """entries(id→entry)에 편집을 순서대로 적용. 반환: (entries, conflicts, applied)."""
    conflicts, applied = [], []
    for ed in sorted(edits, key=lambda x: (x.get("created_at", ""), x.get("edit_id", ""))):
        if only_approved and ed.get("status") != "approved":
            continue
        op, tid = ed.get("op"), ed.get("target_id")
        cur = entries.get(tid)
        before = ed.get("before") or {}
        after = ed.get("after") or {}

        def conflict(reason):
            conflicts.append({"edit_id": ed.get("edit_id"), "op": op, "target_id": tid, "reason": reason})

        try:
            if op == "add":
                if cur is not None:
                    conflict("이미 존재하는 id")
                    continue
                entries[tid] = build_entry(
                    tid, None, after.get("ko_raw", ""), after.get("en_raw", ""),
                    after.get("paren_types"), source_note=after.get("source_note"),
                    definition=after.get("definition"), status="added", strict=True)
            elif op in ("update", "delete", "restore"):
                if cur is None:
                    conflict("대상 항목이 없음")
                    continue
                if op != "restore" and cur["status"] == "deleted":
                    conflict("삭제된 항목은 복원 후 편집 가능")
                    continue
                if op == "restore" and cur["status"] != "deleted":
                    conflict("삭제 상태가 아님")
                    continue
                if any(clean_space(str(before[k])) != clean_space(str(cur.get(k) or ""))
                       for k in ("ko_raw", "en_raw") if k in before):
                    conflict("before 값이 현재 값과 다름")
                    continue
                if op == "delete":
                    cur["prev_status"] = cur["status"]
                    cur["status"] = "deleted"
                    cur["delete_reason"] = ed.get("reason")
                elif op == "restore":
                    cur["status"] = cur.pop("prev_status", "original")
                    cur.pop("delete_reason", None)
                else:
                    merged = {k: cur.get(k) for k in EDITABLE}
                    merged.update({k: v for k, v in after.items() if k in EDITABLE})
                    orig = cur.get("original") or {"ko_raw": cur["ko_raw"], "en_raw": cur["en_raw"]}
                    raw_changed = (merged["ko_raw"] != cur["ko_raw"] or merged["en_raw"] != cur["en_raw"]
                                   or merged.get("paren_types") != cur.get("paren_types"))
                    new = build_entry(
                        tid, cur.get("src_row"), merged["ko_raw"], merged["en_raw"],
                        merged.get("paren_types"),
                        ko_forms=None if raw_changed else (cur["ko_forms"] if "forms_overridden" in cur.get("flags", []) else None),
                        en_fix=None if raw_changed else cur.get("en_fix"),
                        en_alias=cur.get("en_alias"),
                        source_note=merged.get("source_note"), definition=merged.get("definition"),
                        status="added" if cur["status"] == "added" else "updated", strict=True)
                    if cur["status"] != "added":
                        new["original"] = orig
                    entries[tid] = new
            else:
                conflict(f"알 수 없는 연산: {op}")
                continue
        except ExpandError as ex:
            conflict(f"검증 실패: {ex}")
            continue
        applied.append(ed.get("edit_id"))
    return entries, conflicts, applied
