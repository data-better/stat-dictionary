# 통계용어 영한·한영 사전

한국통계학회 통계용어(`data/용어집.xlsx`)를 영어→한국어, 한국어→영어로 찾는 정적 웹 사전입니다.
용어를 추가·수정·삭제할 수 있고, 모든 변경은 원천 파일과 분리된 `data/edits.json`에 기록됩니다.

## 빠르게 시작하기

```bash
pip install -r requirements.txt
python scripts/build_dict.py          # web/data/dict.json 생성 + data/review/ 검토 파일
python scripts/test_build.py          # 수용 기준 검사 (node가 있으면 JS 검사도 함께)
python -m http.server 8000 -d web     # http://localhost:8000
python scripts/export_xlsx.py         # dist/통계용어사전_영한_한영.xlsx
```

## 폴더 구조

```
data/
  용어집.xlsx            원천 (수정 금지)
  overrides.csv          원천 표기 교정: 소괄호 유형, 문자 깨짐, 철자 별칭
  edits.json             용어 추가·수정·삭제 기록
  review/                빌드가 만드는 검토 파일 (소괄호, 대괄호 전개, 충돌)
scripts/
  dictcore.py            전개·정규화·편집 적용 규칙 (web/core.js와 동일)
  build_dict.py          xlsx + overrides + edits → web/data/dict.json
  export_xlsx.py         영한/한영/검토필요/변경이력 엑셀
  import_edits.py        편집요청.xlsx → edits.json (일괄 편집)
  merge_edits.py         웹앱에서 내보낸 편집 파일 → edits.json
  apply_paren_review.py  검토한 review_parens.csv → overrides.csv
  test_build.py          PRD 수용 기준 자동 검사
tests/
  expansion_cases.json   Python·JS 공통 사례
  test_core.js           JS 사례 검사 + 5,059건 전수 일치 검사
  e2e_browser.py         (선택) Playwright 브라우저 점검
web/
  index.html, style.css, core.js, editor.js, app.js, data/dict.json
```

## 검색

- 입력 문자로 방향을 자동 판별합니다(한글 → 한영, 로마자 → 영한). 자동/EN→한/한→EN 버튼으로 고정할 수 있습니다.
- 영문은 대소문자·하이픈·공백·아포스트로피·발음 구별기호를 무시합니다 (`gauss jordan`, `Levy process`).
- 약어(`REML`, `SUR`)와 철자 교정 별칭(`hierarchical Bayes model`)으로도 찾습니다.
- 한글은 대체 표기 어느 것으로도 찾고(`우도비 검증`), 초성(`ㄱㅈㄱㅅ`)으로도 찾습니다.
- 결과가 없으면 비슷한 표제어를 제안합니다. 용어를 누르면 복사됩니다.

## 용어 편집

### 웹앱에서 (한두 건)

1. 화면 오른쪽 위 **편집 모드**를 켭니다 (또는 주소에 `?mode=edit`).
2. **새 용어 추가**, 또는 검색 결과의 **수정/삭제** 버튼을 씁니다.
   - 한글 원문을 입력하면 전개 결과가 바로 보입니다. 소괄호가 있으면 해석(생략 가능/대체어/주석)을 골라야 저장됩니다.
   - 같은 영문에 같은 한글 표기가 이미 있으면 중복 경고가 나옵니다.
   - 삭제는 사유가 필요하고, 5초 안에 되돌리거나 **삭제된 용어**에서 복원할 수 있습니다.
3. 변경은 즉시 내 브라우저의 검색에 반영됩니다(다른 사람에게는 아직 보이지 않음).
4. **내보내기**로 `edits-YYYYMMDDhhmmss.json`을 받습니다.
5. 저장소에 반영합니다.
   ```bash
   python scripts/merge_edits.py ~/Downloads/edits-*.json
   python scripts/build_dict.py && python scripts/test_build.py
   git add data/edits.json web/data/dict.json && git commit -m "용어 편집"
   ```
   배포된 dict.json에 반영된 편집은 다음 방문 때 브라우저에서 자동으로 정리됩니다.

> 편집 모드는 누구나 켤 수 있지만 결과는 그 사람의 브라우저에만 남습니다.
> 공개 사전에 반영하는 권한은 GitHub 저장소 쓰기 권한(커밋·PR 승인)으로 관리합니다.

### 엑셀로 (여러 건)

```bash
python scripts/import_edits.py --template             # data/편집요청.xlsx 생성 (안내·예시 시트 포함)
python scripts/import_edits.py data/편집요청.xlsx --dry-run
python scripts/import_edits.py data/편집요청.xlsx       # 오류가 하나라도 있으면 아무것도 바꾸지 않음
python scripts/build_dict.py
```

### 편집 기록 형식 (`data/edits.json`)

```json
{"edit_id": "e20260915-101500123-ab12", "op": "update", "target_id": "r0003",
 "before": {"ko_raw": "가능도, 우도", "en_raw": "likelihood"},
 "after": {"ko_raw": "가능도, 우도, 라이클리후드"},
 "reason": "외래어 표기 추가", "editor": "DataBetter",
 "created_at": "2026-09-15T10:15:00.123+09:00", "status": "approved"}
```

- `op`: `add` / `update` / `delete` / `restore`. `status`가 `approved`인 것만 빌드에 반영됩니다.
- 빌드는 `created_at` 순으로 적용합니다. `before`가 현재 값과 다르면 건너뛰고 `data/review/review_conflicts.csv`에 남깁니다.
- 같은 원천과 편집 파일이면 항상 같은 `dict.json`이 나옵니다.

## 소괄호 검토 (배포 전 필수)

원천의 소괄호 176행 중 자동 판별이 안 되는 152행은 추정값으로 전개되어 있습니다.

1. `data/review/review_parens.csv`를 엽니다. `paren_types`(optional/alternative/annotation 또는 생략/대체/주석)를 확인·수정하고, 확인한 행의 `reviewed`를 `yes`로 바꿉니다.
2. `python scripts/apply_paren_review.py` → `overrides.csv`에 반영됩니다.
3. `python scripts/build_dict.py --strict`가 통과하면 검토 완료입니다.

대괄호 전개는 휴리스틱이라 `data/review/review_brackets.csv`도 훑어보세요.
틀린 전개는 `overrides.csv`의 `ko_forms`에 `표기1|표기2` 형식으로 직접 적으면 됩니다.
(예: `겉보기 무관[보기에 무관한] 회귀` → `겉보기 무관 회귀|보기에 무관한 회귀`)

## 배포

`.github/workflows/pages.yml`이 main에 push할 때 빌드·테스트 후 `web/`을 GitHub Pages로 배포하고, 엑셀 파일도 함께 올립니다.
저장소 설정 → Pages → Source를 "GitHub Actions"로 지정하세요.

## 출처와 이용

용어 원천은 한국통계학회 통계용어입니다(https://kss.or.kr/homepage/custom/statistics).
공개 배포 전에 학회에 이용 범위를 확인하세요. 화면의 `추가`·`수정` 배지와 엑셀의 `상태` 열은 학회 원본과 다른 내용을 표시합니다.
