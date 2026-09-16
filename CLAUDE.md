# CLAUDE.md — 통계용어 영한·한영 사전

## 절대 규칙
- `data/용어집.xlsx`(원천)는 수정하지 않는다. 빌드가 해시로 검사한다.
- 용어 추가·수정·삭제는 `data/edits.json`으로만 한다. 원천 행을 직접 고치는 코드를 만들지 않는다.
- 원천 표기 교정(문자 깨짐, 소괄호 유형, 철자 별칭)은 `data/overrides.csv`로 한다.
- 모든 항목은 `ko_raw`/`en_raw` 원문과 `src_row`를 보존한다. 수정된 원천 항목은 `original`에 최초 원문을 둔다.
- 삭제는 소프트 삭제(`status: deleted`)다. id(`r####`, `u####`)는 재사용하지 않는다.

## 전개·정규화 규칙
- 규칙은 `scripts/dictcore.py`(Python)와 `web/core.js`(JS)에 **같은 내용으로** 있다. 한쪽을 고치면 반드시 다른 쪽도 고친다.
- 규칙을 바꿀 때는 `tests/expansion_cases.json`에 사례를 먼저 추가한다.

## 커밋 전 필수
```
python scripts/build_dict.py
python scripts/test_build.py      # Python 수용 기준 + node tests/test_core.js (전수 5,059건 JS/Python 일치)
```
배포 전에는 `python scripts/build_dict.py --strict` 와 `python scripts/test_build.py --strict` 가 통과해야 한다.

## 웹앱
- 빌드 도구 없는 vanilla JS. 외부 라이브러리를 추가하지 않는다.
- `localStorage` 대신 IndexedDB(`web/editor.js`)를 쓴다.
- 편집 모드의 변경은 브라우저에만 저장되고, 내보내기 → `scripts/merge_edits.py` → 빌드로 반영된다.
