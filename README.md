# 통계용어 영한·한영 사전

한국통계학회 통계용어(`data/용어집.xlsx`)를 영어→한국어, 한국어→영어로 찾는 정적 웹 사전입니다.
용어를 추가·수정·삭제할 수 있고, 모든 변경은 원천 파일과 분리된 `data/edits.json`에 기록됩니다.


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

## 출처와 이용

용어 원천은 한국통계학회 통계용어입니다(https://kss.or.kr/homepage/custom/statistics).
공개 배포 전에 학회에 이용 범위를 확인하세요. 화면의 `추가`·`수정` 배지와 엑셀의 `상태` 열은 학회 원본과 다른 내용을 표시합니다.
