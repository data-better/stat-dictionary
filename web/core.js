/* 통계용어 사전 공통 로직 (브라우저 + Node).
 * scripts/dictcore.py 와 같은 결과를 내야 한다. tests/expansion_cases.json 으로 검증.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DictCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_FORMS = 8;
  const HANJA_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  const HANGUL_RE = /[\uac00-\ud7a3]/;
  const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const PAREN_TYPES = ["optional", "alternative", "annotation"];
  const EDITABLE = ["ko_raw", "en_raw", "paren_types", "source_note", "definition"];

  class ExpandError extends Error {}

  // ------------------------------------------------------------ 유틸
  const cleanSpace = (s) => String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const stripMarks = (s) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const enKey = (s) => cleanSpace(stripMarks(s)).toLowerCase();
  const compactKey = (s) => enKey(s).replace(/[^0-9a-z\uac00-\ud7a3]/g, "");
  const dedup = (arr) => {
    const seen = new Set(), out = [];
    for (const x of arr) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
    return out;
  };
  function choseong(s) {
    let out = "";
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 0xac00 && c <= 0xd7a3) out += CHOSEONG[Math.floor((c - 0xac00) / 588)];
      else if (ch.trim()) out += ch.toLowerCase();
    }
    return out;
  }
  /** 한글 색인 그룹: ㄱ~ㅎ (된소리는 예사소리로), 그 외는 '기타' */
  function koGroup(s) {
    const c = s.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const ch = CHOSEONG[Math.floor((c - 0xac00) / 588)];
      return { "ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ" }[ch] || ch;
    }
    return "기타";
  }
  function enGroup(s) {
    const ch = stripMarks(s).charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : "기타";
  }

  // ------------------------------------------------------------ 한글 전개
  function checkBalanced(s) {
    const stack = [];
    for (const ch of s) {
      if (ch === "[" || ch === "(") {
        if (stack.length) throw new ExpandError("괄호 안에 괄호를 넣을 수 없습니다");
        stack.push(ch);
      } else if (ch === "]" || ch === ")") {
        const want = ch === "]" ? "[" : "(";
        if (!stack.length || stack.pop() !== want) throw new ExpandError("괄호 짝이 맞지 않습니다");
      }
    }
    if (stack.length) throw new ExpandError("닫히지 않은 괄호가 있습니다");
  }
  function splitTop(s) {
    const parts = []; let buf = "", depth = 0;
    for (const ch of s) {
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(buf); buf = ""; } else buf += ch;
    }
    parts.push(buf);
    return parts.map(cleanSpace).filter(Boolean);
  }
  function parseSegments(part) {
    const segs = []; let i = 0;
    while (i < part.length) {
      const ch = part[i];
      if (ch === "[" || ch === "(") {
        const j = part.indexOf(ch === "[" ? "]" : ")", i);
        segs.push([ch === "[" ? "alt" : "paren", part.slice(i + 1, j)]);
        i = j + 1;
      } else {
        let j = i;
        while (j < part.length && part[j] !== "[" && part[j] !== "(") j++;
        segs.push(["text", part.slice(i, j)]);
        i = j;
      }
    }
    return segs;
  }
  const parenKind = (c) => (HANJA_RE.test(c) || !HANGUL_RE.test(c) ? "annotation" : null);
  const unitOf = (p) => p.slice(p.lastIndexOf(" ") + 1);
  function guessParen(unit, content, next) {
    if (content.length >= 2 && unit &&
        (content[0] === unit[0] || (content.length === unit.length && /^[\uac00-\ud7a3]/.test(next || ""))))
      return "alternative";
    return "optional";
  }
  function commonPrefix(a, b) {
    let n = 0;
    while (n < Math.min(a.length, b.length) && a[n] === b[n]) n++;
    return n;
  }
  function replaceUnit(prefix, alt) {
    const unit = unitOf(prefix);
    const head = prefix.slice(0, prefix.length - unit.length);
    if (!unit) return prefix + alt;
    if (alt.includes(" ") || alt.length >= unit.length - 1 || commonPrefix(unit, alt) >= 1) return head + alt;
    return head + unit.slice(0, unit.length - alt.length) + alt;
  }

  function expandKo(raw, parenTypes, opts) {
    const cap = (opts && opts.cap) || MAX_FORMS;
    const strict = !!(opts && opts.strict);
    const s = cleanSpace(raw);
    if (!s) throw new ExpandError("한글 용어가 비어 있습니다");
    try { checkBalanced(s); } catch (e) {
      if (strict) throw e;
      return { forms: [s], notes: [], parens: [], flags: ["unbalanced"] };
    }
    parenTypes = parenTypes || [];
    for (const t of parenTypes) if (!PAREN_TYPES.includes(t)) throw new ExpandError("알 수 없는 소괄호 유형: " + t);
    const notes = [], parens = [], flags = [];
    let forms = [];
    for (const part of splitTop(s)) {
      const segs = parseSegments(part);
      let prefixes = [""];
      segs.forEach(([kind, content], k) => {
        const cc = cleanSpace(content);
        if (kind === "text") {
          prefixes = prefixes.map((p) => p + content);
        } else if (kind === "alt") {
          const alts = content.split(",").map(cleanSpace).filter(Boolean);
          const next = [];
          for (const p of prefixes) { next.push(p); for (const a of alts) next.push(replaceUnit(p, a)); }
          prefixes = next;
        } else {
          if (parenKind(cc)) { notes.push(cc); return; }
          const idx = parens.length;
          const nxt = k + 1 < segs.length && segs[k + 1][0] === "text" ? segs[k + 1][1].slice(0, 1) : "";
          const given = idx < parenTypes.length ? parenTypes[idx] : null;
          const type = given || guessParen(unitOf(prefixes[0]), cc, nxt);
          parens.push({ content: cc, type, guessed: !given });
          if (type === "annotation") notes.push(cc);
          else if (type === "alternative") prefixes = prefixes.flatMap((p) => [p, replaceUnit(p, cc)]);
          else prefixes = prefixes.flatMap((p) => [p + cc, p]);
        }
      });
      forms.push(...prefixes.map(cleanSpace));
    }
    forms = dedup(forms);
    if (forms.length > cap) {
      if (strict) throw new ExpandError(`전개 결과가 ${forms.length}개로 상한(${cap})을 넘습니다`);
      forms = forms.slice(0, cap);
      flags.push("expansion_capped");
    }
    return { forms, notes: dedup(notes), parens, flags };
  }

  // ------------------------------------------------------------ 영문 정규화
  function normalizeEn(raw) {
    let s = cleanSpace(raw);
    if (!s) throw new ExpandError("영문 용어가 비어 있습니다");
    const abbr = []; let sense = null, m;
    if ((m = s.match(/;\s*([^;]+)$/))) { abbr.push(cleanSpace(m[1])); s = s.slice(0, m.index); }
    if ((m = s.match(/\s*\((\d+)\)\s*$/))) { sense = parseInt(m[1], 10); s = s.slice(0, m.index); }
    s = cleanSpace(s.replace(/\s*\(([^()]*)\)/g, (all, inner) => {
      inner = cleanSpace(inner);
      if ((inner.match(/[A-Z]/g) || []).length >= 2) { abbr.push(inner); return " "; }
      return all;
    }));
    const variants = dedup(s.split(/\s*[/,]\s*/).map(cleanSpace));
    if (!variants.length) throw new ExpandError("영문 용어가 비어 있습니다");
    return { en: variants[0], variants: variants.slice(1), abbr: dedup(abbr), sense };
  }

  // ------------------------------------------------------------ 항목
  function buildEntry(id, srcRow, koRaw, enRaw, o) {
    o = o || {};
    const ko = expandKo(koRaw, o.paren_types, { strict: o.strict });
    const en = normalizeEn(o.en_fix || enRaw);
    const flags = ko.flags.slice();
    if (o.ko_forms) { ko.forms = dedup(o.ko_forms.map(cleanSpace)); flags.push("forms_overridden"); }
    if (o.en_fix) flags.push("en_fixed");
    if (ko.parens.some((p) => p.guessed) && !o.ko_forms) flags.push("paren_unreviewed");
    return {
      id, src_row: srcRow,
      ko_raw: cleanSpace(koRaw), en_raw: cleanSpace(enRaw),
      ko_forms: ko.forms, ko_primary: ko.forms[0],
      en: en.en, en_variants: en.variants, abbr: en.abbr, sense: en.sense,
      notes: ko.notes,
      paren_types: o.paren_types && o.paren_types.length ? ko.parens.map((p) => p.type) : null,
      en_fix: o.en_fix || null, en_alias: o.en_alias || [],
      source_note: o.source_note || null, definition: o.definition || null,
      status: o.status || "original", flags,
    };
  }

  /** dict.json 의 압축 항목을 완전한 형태로 되돌린다. */
  function inflate(e) {
    return Object.assign({
      src_row: null, ko_forms: [], en_variants: [], abbr: [], sense: null, notes: [],
      paren_types: null, en_fix: null, en_alias: [], source_note: null, definition: null,
      status: "original", flags: [],
    }, e);
  }

  function validateDraft(d) {
    const errors = [];
    let ko = null, en = null;
    try { ko = expandKo(d.ko_raw, d.paren_types, { strict: true }); } catch (e) { errors.push({ field: "ko_raw", message: e.message }); }
    try { en = normalizeEn(d.en_raw); } catch (e) { errors.push({ field: "en_raw", message: e.message }); }
    return { ok: errors.length === 0, errors, ko, en };
  }

  /** 같은 영문 키(+의미번호)이면서 한글 표기가 겹치는 기존 항목 */
  function findDuplicates(entries, draft, selfId) {
    const v = validateDraft(draft);
    if (!v.ok) return [];
    const key = enKey(v.en.en) + "#" + (v.en.sense || "");
    const forms = new Set(v.ko.forms);
    return entries.filter((e) => e.id !== selfId && e.status !== "deleted" &&
      enKey(e.en) + "#" + (e.sense || "") === key && e.ko_forms.some((f) => forms.has(f)));
  }

  function applyEdits(entriesById, edits, opts) {
    const onlyApproved = !opts || opts.onlyApproved !== false;
    const conflicts = [], applied = [];
    const sorted = edits.slice().sort((a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "") || (a.edit_id || "").localeCompare(b.edit_id || ""));
    for (const ed of sorted) {
      if (onlyApproved && ed.status !== "approved") continue;
      const { op, target_id: tid } = ed;
      const cur = entriesById[tid];
      const before = ed.before || {}, after = ed.after || {};
      const conflict = (reason) => conflicts.push({ edit_id: ed.edit_id, op, target_id: tid, reason });
      try {
        if (op === "add") {
          if (cur) { conflict("이미 존재하는 id"); continue; }
          entriesById[tid] = buildEntry(tid, null, after.ko_raw || "", after.en_raw || "", {
            paren_types: after.paren_types, source_note: after.source_note,
            definition: after.definition, status: "added", strict: true });
        } else if (op === "update" || op === "delete" || op === "restore") {
          if (!cur) { conflict("대상 항목이 없음"); continue; }
          if (op !== "restore" && cur.status === "deleted") { conflict("삭제된 항목은 복원 후 편집 가능"); continue; }
          if (op === "restore" && cur.status !== "deleted") { conflict("삭제 상태가 아님"); continue; }
          if (["ko_raw", "en_raw"].some((k) => k in before && cleanSpace(before[k]) !== cleanSpace(cur[k] || ""))) {
            conflict("before 값이 현재 값과 다름"); continue;
          }
          if (op === "delete") {
            cur.prev_status = cur.status; cur.status = "deleted"; cur.delete_reason = ed.reason || null;
          } else if (op === "restore") {
            cur.status = cur.prev_status || "original"; delete cur.prev_status; delete cur.delete_reason;
          } else {
            const merged = {};
            for (const k of EDITABLE) merged[k] = k in after ? after[k] : cur[k];
            const orig = cur.original || { ko_raw: cur.ko_raw, en_raw: cur.en_raw };
            const rawChanged = merged.ko_raw !== cur.ko_raw || merged.en_raw !== cur.en_raw ||
              JSON.stringify(merged.paren_types || null) !== JSON.stringify(cur.paren_types || null);
            const next = buildEntry(tid, cur.src_row, merged.ko_raw, merged.en_raw, {
              paren_types: merged.paren_types,
              ko_forms: rawChanged ? null : ((cur.flags || []).includes("forms_overridden") ? cur.ko_forms : null),
              en_fix: rawChanged ? null : cur.en_fix,
              en_alias: cur.en_alias, source_note: merged.source_note, definition: merged.definition,
              status: cur.status === "added" ? "added" : "updated", strict: true });
            if (cur.status !== "added") next.original = orig;
            entriesById[tid] = next;
          }
        } else { conflict("알 수 없는 연산: " + op); continue; }
      } catch (e) {
        if (!(e instanceof ExpandError)) throw e;
        conflict("검증 실패: " + e.message); continue;
      }
      applied.push(ed.edit_id);
    }
    return { entries: entriesById, conflicts, applied };
  }

  return {
    MAX_FORMS, PAREN_TYPES, ExpandError,
    cleanSpace, stripMarks, enKey, compactKey, choseong, koGroup, enGroup,
    expandKo, normalizeEn, buildEntry, inflate, validateDraft, findDuplicates, applyEdits,
  };
});
