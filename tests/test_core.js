// node tests/test_core.js  — 공통 사례 + Python 빌드 결과와의 전수 일치 검사
const fs = require("fs");
const path = require("path");
const C = require("../web/core.js");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "expansion_cases.json"), "utf8"));
let fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, msg) => { if (!ok) { fail++; console.error("FAIL:", msg); } };

for (const c of cases.ko) {
  try {
    const r = C.expandKo(c.raw, c.paren_types, { strict: true });
    check(!c.error, `오류가 나야 함: ${c.raw}`);
    if (c.error) continue;
    check(eq(r.forms, c.forms), `${c.raw} forms ${JSON.stringify(r.forms)}`);
    if (c.notes) check(eq(r.notes, c.notes), `${c.raw} notes ${JSON.stringify(r.notes)}`);
    if (c.paren) check(eq(r.parens.map((p) => p.type), c.paren), `${c.raw} paren`);
  } catch (e) {
    check(c.error && e instanceof C.ExpandError, `${c.raw}: ${e.message}`);
  }
}
for (const c of cases.en) {
  try {
    const r = C.normalizeEn(c.raw);
    check(!c.error, `오류가 나야 함: ${c.raw}`);
    if (c.error) continue;
    for (const k of ["en", "variants", "abbr", "sense"]) check(eq(r[k], c[k]), `${c.raw} ${k}=${JSON.stringify(r[k])}`);
    check(C.compactKey(r.en) === c.compact, `${c.raw} compact`);
  } catch (e) {
    check(c.error, `${c.raw}: ${e.message}`);
  }
}
for (const [s, want] of cases.choseong) check(C.choseong(s) === want, `choseong ${s}`);

// 전수 비교: Python이 만든 dict.json 과 JS 전개 결과
const dictPath = path.join(__dirname, "..", "web", "data", "dict.json");
if (fs.existsSync(dictPath)) {
  const dict = JSON.parse(fs.readFileSync(dictPath, "utf8"));
  let n = 0;
  for (const raw of dict.entries) {
    const e = C.inflate(raw);
    if (e.status !== "original") continue;
    const opts = { paren_types: e.paren_types, en_fix: e.en_fix, en_alias: e.en_alias,
      source_note: e.source_note, ko_forms: e.flags.includes("forms_overridden") ? e.ko_forms : null };
    const js = C.buildEntry(e.id, e.src_row, e.ko_raw, e.en_raw, opts);
    for (const k of ["ko_forms", "en", "en_variants", "abbr", "sense", "notes", "flags"]) {
      if (!eq(js[k], e[k])) { check(false, `${e.id} ${k}: py=${JSON.stringify(e[k])} js=${JSON.stringify(js[k])}`); break; }
    }
    n++;
  }
  console.log(`전수 비교 ${n}건`);
}
console.log(fail ? `JS 테스트 실패 ${fail}건` : "JS 테스트 통과");
process.exit(fail ? 1 : 0);
