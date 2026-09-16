/* 통계용어 영한·한영 사전 — 검색, 색인, 편집 UI */
(function () {
  "use strict";
  const C = window.DictCore;
  const U = window.EditUtil;
  const S = window.EditStore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const PAGE = 40;
  const BROWSE_PAGE = 200;
  const collKo = new Intl.Collator("ko");
  const STATUS_LABEL = { added: "추가", updated: "수정", deleted: "삭제됨" };
  const OP_LABEL = { add: "추가", update: "수정", delete: "삭제", restore: "복원" };
  const FIELD_LABEL = { ko_raw: "한글", en_raw: "영문", paren_types: "소괄호", definition: "뜻풀이", source_note: "출처 메모" };
  const PAREN_LABEL = { optional: "생략 가능", alternative: "대체어", annotation: "주석" };

  const state = {
    base: null,          // dict.json 원본
    appliedIds: new Set(),
    local: [],           // 브라우저에 저장된 편집
    entries: {},         // 편집 미리보기까지 반영된 항목 (id → entry)
    conflicts: [],
    idx: null,
    dir: "auto",
    editMode: false,
    list: [],            // 현재 결과
    shown: 0,
    renderer: null,
    browse: { kind: "en", letter: null },
  };

  // ------------------------------------------------------------ 유틸
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isJamoQuery = (q) => /^[ㄱ-ㅎ\s]+$/.test(q);
  const hasHangul = (q) => /[\uac00-\ud7a3ㄱ-ㅎㅏ-ㅣ]/.test(q);
  const koCompact = (s) => C.cleanSpace(s).replace(/\s+/g, "").toLowerCase();
  const enSortKey = (s) => C.enKey(s).replace(/[^0-9a-z ]/g, "");
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  let toastTimer;
  function toast(msg, action) {
    const el = $("#toast");
    el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : "");
    el.hidden = false;
    if (action) el.querySelector("button").onclick = () => { el.hidden = true; action.run(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 5000 : 1800);
  }

  // ------------------------------------------------------------ 데이터
  async function load() {
    const res = await fetch("data/dict.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`dict.json을 불러오지 못했습니다 (${res.status})`);
    state.base = await res.json();
    state.appliedIds = new Set(state.base.meta.applied_edit_ids || []);
    state.local = await S.list();
    // 저장소에 이미 반영된 편집은 브라우저에서 정리한다.
    const done = state.local.filter((e) => state.appliedIds.has(e.edit_id)).map((e) => e.edit_id);
    if (done.length) {
      await S.removeMany(done);
      state.local = state.local.filter((e) => !state.appliedIds.has(e.edit_id));
    }
    rebuild();
    const m = state.base.meta;
    $("#meta").textContent = `원천 ${m.rows.toLocaleString()}행, 저장소 편집 ${m.edits_applied}건 반영`;
    if (!(await S.isPersistent())) toast("이 브라우저에서는 편집 내용을 저장할 수 없어, 창을 닫으면 사라집니다.");
  }

  function rebuild() {
    const map = baseEntries();
    const edits = state.local.map((e) => JSON.parse(JSON.stringify(e)));
    const r = C.applyEdits(map, edits, { onlyApproved: false });
    state.entries = r.entries;
    state.conflicts = r.conflicts;
    const draftIds = new Set(state.local.filter((e) => e.status !== "approved").map((e) => e.target_id));
    for (const e of Object.values(state.entries)) e.draft = draftIds.has(e.id);
    buildIndex();
    updateEditSummary();
  }

  function buildIndex() {
    const enGroups = new Map();
    const koGroups = new Map();
    for (const e of Object.values(state.entries)) {
      if (e.status === "deleted") continue;
      const gk = C.enKey(e.en) + "#" + (e.sense || "");
      if (!enGroups.has(gk)) enGroups.set(gk, { key: gk, en: e.en, sense: e.sense, entries: [], keys: new Set() });
      const g = enGroups.get(gk);
      g.entries.push(e);
      for (const s of [e.en, ...e.en_variants, ...e.abbr, ...e.en_alias]) {
        const k = C.compactKey(s);
        if (k) g.keys.add(k);
      }
      e.ko_forms.forEach((f) => {
        if (!koGroups.has(f)) koGroups.set(f, { form: f, entries: [], key: koCompact(f), cho: C.choseong(f).replace(/\s/g, "") });
        koGroups.get(f).entries.push(e);
      });
    }
    const order = (e) => [e.src_row == null ? 1e9 : e.src_row, e.id];
    const byOrder = (a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1].localeCompare(y[1]); };
    const en = [...enGroups.values()];
    en.forEach((g) => { g.entries.sort(byOrder); g.sortKey = enSortKey(g.en); g.letter = C.enGroup(g.en); g.keys = [...g.keys]; });
    en.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || (a.sense || 0) - (b.sense || 0));
    const ko = [...koGroups.values()];
    ko.forEach((g) => { g.entries.sort(byOrder); g.letter = C.koGroup(g.form); });
    ko.sort((a, b) => (a.letter === "기타") - (b.letter === "기타") || collKo.compare(a.form, b.form));
    state.idx = { en, ko };
  }

  // ------------------------------------------------------------ 검색
  function searchEn(q) {
    const k = C.compactKey(q);
    if (!k) return [];
    const out = [];
    for (const g of state.idx.en) {
      let score = 9;
      for (const key of g.keys) {
        if (key === k) { score = 0; break; }
        if (key.startsWith(k)) score = Math.min(score, 1);
        else if (key.includes(k)) score = Math.min(score, 2);
      }
      if (score < 9) out.push({ g, score });
    }
    out.sort((a, b) => a.score - b.score || a.g.sortKey.length - b.g.sortKey.length || a.g.sortKey.localeCompare(b.g.sortKey));
    return out.map((x) => ({ type: "en", g: x.g }));
  }

  function searchKo(q) {
    const cho = isJamoQuery(q);
    const k = cho ? q.replace(/\s/g, "") : koCompact(q);
    if (!k) return [];
    const out = [];
    for (const g of state.idx.ko) {
      const hay = cho ? g.cho : g.key;
      let score = 9;
      if (hay === k) score = 0;
      else if (hay.startsWith(k)) score = 1;
      else if (hay.includes(k)) score = 2;
      if (score < 9) out.push({ g, score });
    }
    out.sort((a, b) => a.score - b.score || a.g.form.length - b.g.form.length || collKo.compare(a.g.form, b.g.form));
    return out.map((x) => ({ type: "ko", g: x.g }));
  }

  function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function suggest(q, dir) {
    const max = q.length > 8 ? 3 : 2;
    const cands = [];
    if (dir === "en") {
      const k = C.compactKey(q);
      for (const g of state.idx.en) {
        const d = Math.min(...g.keys.map((key) => levenshtein(k, key.slice(0, k.length + 2), max)));
        if (d <= max) cands.push({ label: g.en, d });
      }
    } else {
      const k = koCompact(q);
      for (const g of state.idx.ko) {
        const d = levenshtein(k, g.key, max);
        if (d <= max) cands.push({ label: g.form, d });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    return [...new Set(cands.map((c) => c.label))].slice(0, 5);
  }

  function effectiveDir(q) {
    if (state.dir !== "auto") return state.dir;
    return hasHangul(q) ? "ko" : "en";
  }

  function runSearch() {
    const q = $("#q").value.trim();
    const url = new URL(location.href);
    if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
    history.replaceState(null, "", url);
    if (!q) {
      if (state.browse.letter) return showBrowse();
      state.list = [];
      $("#results").innerHTML = "";
      $("#more").hidden = true;
      $("#status").textContent = `영한 ${state.idx.en.length.toLocaleString()}개, 한영 ${state.idx.ko.length.toLocaleString()}개 표제어가 있습니다.`;
      return;
    }
    setLetter(null);
    const dir = effectiveDir(q);
    let list = dir === "en" ? searchEn(q) : searchKo(q);
    let note = "";
    if (!list.length && state.dir === "auto") {
      const other = dir === "en" ? searchKo(q) : searchEn(q);
      if (other.length) { list = other; note = " (반대 방향에서 찾음)"; }
    }
    state.list = list;
    state.shown = 0;
    state.renderer = renderResult;
    $("#results").innerHTML = "";
    const label = dir === "en" ? "영한" : "한영";
    if (!list.length) {
      const sug = suggest(q, dir);
      $("#status").textContent = `'${q}'에 맞는 ${label} 표제어가 없습니다.`;
      $("#results").innerHTML = `<div class="empty"><h2>찾는 용어가 없습니다</h2>` +
        (sug.length ? `<p>비슷한 용어: ${sug.map((s) => `<button type="button" class="link" data-search="${esc(s)}">${esc(s)}</button>`).join(", ")}</p>` : "<p>철자를 확인하거나 앞부분만 입력해 보세요.</p>") +
        (state.editMode ? `<p><button type="button" class="btn btn-solid" data-action="new" data-prefill="${esc(q)}">'${esc(q)}'을 새 용어로 추가</button></p>` : "") +
        `</div>`;
      $("#more").hidden = true;
      return;
    }
    $("#status").textContent = `${label} ${list.length.toLocaleString()}개${note}`;
    renderMore();
  }

  function renderMore() {
    const box = $("#results");
    const page = state.renderer === renderBrowseItem ? BROWSE_PAGE : PAGE;
    const slice = state.list.slice(state.shown, state.shown + page);
    const html = slice.map(state.renderer).join("");
    if (state.renderer === renderBrowseItem) {
      let ul = box.querySelector("ul.browse");
      if (!ul) { box.innerHTML = '<ul class="browse"></ul>'; ul = box.querySelector("ul.browse"); }
      ul.insertAdjacentHTML("beforeend", html);
    } else {
      box.insertAdjacentHTML("beforeend", html);
    }
    state.shown += slice.length;
    $("#more").hidden = state.shown >= state.list.length;
    $("#more").textContent = `더 보기 (${(state.list.length - state.shown).toLocaleString()}개 남음)`;
  }

  // ------------------------------------------------------------ 렌더링
  function badges(e) {
    let h = "";
    if (STATUS_LABEL[e.status]) h += ` <span class="badge badge-${e.status}">${STATUS_LABEL[e.status]}</span>`;
    if (e.draft) h += ' <span class="badge badge-draft">초안</span>';
    return h;
  }
  function rowActions(e) {
    if (!state.editMode) return "";
    return `<div class="row-actions">
      <button type="button" class="btn btn-sm" data-action="edit" data-id="${e.id}">수정</button>
      <button type="button" class="btn btn-sm" data-action="delete" data-id="${e.id}">삭제</button></div>`;
  }
  function rawBlock(e) {
    const orig = e.original ? `<br>수정 전: <code>${esc(e.original.ko_raw)}</code> ↔ <code lang="en">${esc(e.original.en_raw)}</code>` : "";
    return `<details class="raw"><summary>원문 보기</summary>
      <code>${esc(e.ko_raw)}</code> ↔ <code lang="en">${esc(e.en_raw)}</code>
      ${e.src_row ? ` · 원천 ${e.src_row}행` : " · 사용자 추가"} · <span>${e.id}</span>${orig}
      ${e.source_note ? `<br>출처 메모: ${esc(e.source_note)}` : ""}</details>`;
  }
  const termBtn = (text, cls, lang) =>
    `<button type="button" class="term ${cls || ""}" data-copy="${esc(text)}" ${lang ? `lang="${lang}"` : ""} title="눌러서 복사">${esc(text)}</button>`;

  function renderResult(item) {
    return item.type === "en" ? renderEnCard(item.g) : renderKoCard(item.g);
  }

  function renderEnCard(g) {
    const variants = [...new Set(g.entries.flatMap((e) => e.en_variants))];
    const abbr = [...new Set(g.entries.flatMap((e) => e.abbr))];
    const senses = g.entries.map((e) => `
      <li class="sense">
        <div>
          <div class="terms">${e.ko_forms.map((f, i) => termBtn(f, i === 0 ? "primary" : "")).join('<span class="sep">,</span>')}${badges(e)}</div>
          ${e.notes.length ? `<div class="syn">주석: ${e.notes.map(esc).join(", ")}</div>` : ""}
          ${e.definition ? `<p class="def">${esc(e.definition)}</p>` : ""}
          ${rawBlock(e)}
        </div>
        ${rowActions(e)}
      </li>`).join("");
    return `<article class="entry">
      <div class="head">
        <h2 class="headword en" lang="en">${termBtn(g.en, "en", "en")}${g.sense ? `<sup>${g.sense}</sup>` : ""}</h2>
        ${abbr.map((a) => `<span class="abbr">${esc(a)}</span>`).join("")}
        ${variants.length ? `<span class="aside" lang="en">= ${variants.map(esc).join(", ")}</span>` : ""}
      </div>
      <ul class="senses">${senses}</ul></article>`;
  }

  function renderKoCard(g) {
    const synonyms = [...new Set(g.entries.flatMap((e) => e.ko_forms))].filter((f) => f !== g.form);
    const senses = g.entries.map((e) => `
      <li class="sense">
        <div>
          <div class="terms">${termBtn(e.en, "en primary", "en")}${e.sense ? `<sup>${e.sense}</sup>` : ""}
            ${e.abbr.map((a) => `<span class="abbr">${esc(a)}</span>`).join(" ")}
            ${e.en_variants.length ? `<span class="aside" lang="en">= ${e.en_variants.map(esc).join(", ")}</span>` : ""}${badges(e)}</div>
          ${e.definition ? `<p class="def">${esc(e.definition)}</p>` : ""}
          ${rawBlock(e)}
        </div>
        ${rowActions(e)}
      </li>`).join("");
    const notes = [...new Set(g.entries.flatMap((e) => e.notes))];
    return `<article class="entry">
      <div class="head">
        <h2 class="headword">${termBtn(g.form)}</h2>
        ${notes.length ? `<span class="aside">${notes.map(esc).join(", ")}</span>` : ""}
      </div>
      ${synonyms.length ? `<div class="syn">같은 뜻: ${synonyms.map((s) => `<button type="button" class="link" data-search="${esc(s)}">${esc(s)}</button>`).join(", ")}</div>` : ""}
      <ul class="senses">${senses}</ul></article>`;
  }

  // ------------------------------------------------------------ 색인
  const EN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat("기타");
  const KO_LETTERS = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ".split("").concat("기타");

  function renderLetters() {
    const kind = state.browse.kind;
    const letters = kind === "en" ? EN_LETTERS : KO_LETTERS;
    const counts = {};
    for (const g of state.idx[kind]) counts[g.letter] = (counts[g.letter] || 0) + 1;
    $("#letters").innerHTML = letters.map((l) =>
      `<button type="button" data-letter="${l}" aria-pressed="${state.browse.letter === l}" ${counts[l] ? "" : "disabled"} title="${(counts[l] || 0).toLocaleString()}개">${l}</button>`).join("");
    document.querySelectorAll("[data-index]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.index === kind)));
  }
  function setLetter(l) { state.browse.letter = l; renderLetters(); }

  function renderBrowseItem(g) {
    if (g.form !== undefined) {
      const gloss = [...new Set(g.entries.map((e) => e.en))].join("; ");
      return `<li><button type="button" class="link" data-search="${esc(g.form)}" data-dir="ko">${esc(g.form)}</button><span class="gloss" lang="en">${esc(gloss)}</span></li>`;
    }
    const gloss = [...new Set(g.entries.map((e) => e.ko_primary))].join("; ");
    return `<li><button type="button" class="link" lang="en" data-search="${esc(g.en)}" data-dir="en">${esc(g.en)}${g.sense ? `<sup>${g.sense}</sup>` : ""}</button><span class="gloss">${esc(gloss)}</span></li>`;
  }

  function showBrowse() {
    const { kind, letter } = state.browse;
    state.list = state.idx[kind].filter((g) => g.letter === letter);
    state.shown = 0;
    state.renderer = renderBrowseItem;
    $("#results").innerHTML = "";
    $("#status").textContent = `${kind === "en" ? "영한" : "한영"} 색인 '${letter}' ${state.list.length.toLocaleString()}개`;
    renderMore();
  }

  function rerender() {
    if ($("#q").value.trim()) runSearch();
    else if (state.browse.letter) showBrowse();
    else runSearch();
    renderLetters();
  }

  // ------------------------------------------------------------ 편집: 공통
  const activeLocal = () => state.local;
  function updateEditSummary() {
    const n = state.local.length;
    const unexported = state.local.filter((e) => !e.exported).length;
    $("#edit-summary").textContent = `변경 ${n}건` + (unexported ? `, 내보내지 않음 ${unexported}건` : "") +
      (state.conflicts.length ? `, 충돌 ${state.conflicts.length}건` : "");
  }
  function nextUid() {
    let max = 0;
    const ids = Object.keys(state.entries).concat(state.local.map((e) => e.target_id));
    for (const id of ids) { const m = /^u(\d+)$/.exec(id || ""); if (m) max = Math.max(max, +m[1]); }
    return "u" + String(max + 1).padStart(4, "0");
  }
  async function saveEdit(edit) {
    await S.put(edit);
    state.local = await S.list();
    rebuild();
    rerender();
  }
  async function editorName() { return (await S.getSetting("editor")) || ""; }

  function setEditMode(on) {
    state.editMode = on;
    $("#editbar").hidden = !on;
    $("#edit-toggle").checked = on;
    const url = new URL(location.href);
    if (on) url.searchParams.set("mode", "edit"); else url.searchParams.delete("mode");
    history.replaceState(null, "", url);
    rerender();
  }

  // ------------------------------------------------------------ 편집: 폼
  const form = {
    mode: "add", targetId: null, editId: null, parens: [], types: [],
  };

  async function openForm(opts) {
    Object.assign(form, { mode: "add", targetId: null, editId: null, types: [] }, opts);
    const dlg = $("#form-dialog");
    const src = opts.values || {};
    $("#form-title").textContent = form.mode === "add" ? "새 용어 추가" : `용어 수정 (${form.targetId})`;
    $("#f-ko").value = src.ko_raw || "";
    $("#f-en").value = src.en_raw || "";
    $("#f-def").value = src.definition || "";
    $("#f-src").value = src.source_note || "";
    $("#f-reason").value = opts.reason || "";
    $("#f-editor").value = opts.editor || (await editorName());
    $("#f-draft").checked = opts.status === "draft";
    form.types = (src.paren_types || []).slice();
    try { form.parens = C.expandKo(src.ko_raw || "", null).parens; } catch (e) { form.parens = []; }
    form.original = opts.original || src;
    $("#paren-fields").dataset.open = "0";
    $(".more-fields").open = !!(src.definition || src.source_note);
    refreshPreview();
    dlg.showModal();
    $("#f-ko").focus();
  }

  function currentDraft() {
    const parens = form.parens;
    const types = parens.map((p, i) => form.types[i] || "");
    return {
      ko_raw: C.cleanSpace($("#f-ko").value),
      en_raw: C.cleanSpace($("#f-en").value),
      paren_types: parens.length ? types : null,
      definition: $("#f-def").value.trim() || null,
      source_note: $("#f-src").value.trim() || null,
    };
  }

  function refreshPreview() {
    const ko = $("#f-ko").value;
    let parens = [];
    try { parens = C.expandKo(ko, null).parens; } catch (e) { parens = []; }
    const sig = parens.map((p) => p.content).join("\u0000");
    const pf = $("#paren-fields");
    if (sig !== form.parens.map((p) => p.content).join("\u0000")) {
      // 소괄호 구성이 바뀌면 같은 위치·같은 내용의 선택만 유지
      form.types = parens.map((p, i) => (form.parens[i] && form.parens[i].content === p.content ? form.types[i] : "") || "");
    }
    form.parens = parens;
    pf.hidden = !parens.length;
    const fieldsHtml = parens.length ? `<label>소괄호 해석 <span class="req">필수</span></label>` + parens.map((p, i) => `
      <div class="paren-row"><span>(${esc(p.content)})</span>
        <select data-paren="${i}" aria-label="(${esc(p.content)}) 해석">
          <option value="">선택하세요 (추정: ${PAREN_LABEL[p.type]})</option>
          ${C.PAREN_TYPES.map((t) => `<option value="${t}" ${form.types[i] === t ? "selected" : ""}>${PAREN_LABEL[t]}</option>`).join("")}
        </select></div>`).join("") +
      `<p class="hint">생략 가능: 소거(법) → 소거법, 소거. 대체어: 지렛대점(지레점) → 지렛대점, 지레점. 주석: 표기에서 뺍니다.</p>` : "";
    if (pf.dataset.sig !== sig || pf.dataset.open !== "1") {
      pf.innerHTML = fieldsHtml;
      pf.dataset.sig = sig;
      pf.dataset.open = "1";
    }

    const d = currentDraft();
    const errs = [];
    const box = $("#preview");
    if (!d.ko_raw && !d.en_raw) { box.innerHTML = ""; setFormError([]); return; }
    const missing = form.parens.some((p, i) => !form.types[i]);
    const v = C.validateDraft(Object.assign({}, d, { paren_types: missing ? null : d.paren_types }));
    v.errors.forEach((e) => errs.push((e.field === "ko_raw" ? "한글: " : "영문: ") + e.message));
    if (missing) errs.push("소괄호 해석을 모두 선택하세요.");
    let html = "<dl>";
    if (v.ko) html += `<dt>한글 표기</dt><dd>${v.ko.forms.map((f, i) => (i === 0 ? `<strong>${esc(f)}</strong>` : esc(f))).join(", ")} <span class="muted">(${v.ko.forms.length}개${v.ko.forms.length ? ", 첫 표기가 대표" : ""})</span></dd>`;
    if (v.ko && v.ko.notes.length) html += `<dt>주석</dt><dd>${v.ko.notes.map(esc).join(", ")}</dd>`;
    if (v.en) {
      html += `<dt>영문 표제어</dt><dd lang="en">${esc(v.en.en)}${v.en.sense ? `<sup>${v.en.sense}</sup>` : ""}</dd>`;
      if (v.en.variants.length) html += `<dt>영문 이형</dt><dd lang="en">${v.en.variants.map(esc).join(", ")}</dd>`;
      if (v.en.abbr.length) html += `<dt>약어</dt><dd>${v.en.abbr.map(esc).join(", ")}</dd>`;
    }
    html += "</dl>";
    if (v.ok && !missing) {
      const dups = C.findDuplicates(Object.values(state.entries), d, form.targetId);
      if (dups.length) html += `<p class="warn">중복 가능: ${dups.map((e) => `${esc(e.id)} ${esc(e.ko_primary)} / ${esc(e.en)}`).join("; ")}. 같은 용어라면 기존 항목을 수정하세요. 그래도 저장할 수 있습니다.</p>`;
    }
    if (form.mode !== "add" && form.original && d.ko_raw === C.cleanSpace(form.original.ko_raw || "") &&
        d.en_raw === C.cleanSpace(form.original.en_raw || "") && JSON.stringify(d.paren_types || null) === JSON.stringify(form.original.paren_types || null) &&
        (d.definition || null) === (form.original.definition || null) && (d.source_note || null) === (form.original.source_note || null)) {
      errs.push("바뀐 내용이 없습니다.");
    }
    box.innerHTML = html;
    setFormError(errs);
  }
  function setFormError(errs) {
    $("#form-error").textContent = errs.join(" ");
    $("#form-save").disabled = errs.length > 0;
  }

  async function submitForm(ev) {
    ev.preventDefault();
    refreshPreview();
    if ($("#form-save").disabled) return;
    const d = currentDraft();
    const editor = C.cleanSpace($("#f-editor").value);
    await S.setSetting("editor", editor);
    const status = $("#f-draft").checked ? "draft" : "approved";
    let edit;
    if (form.editId) {
      // 아직 내보내지 않은 편집을 고치는 경우: 기록 자체를 갱신
      edit = state.local.find((e) => e.edit_id === form.editId);
      edit = Object.assign({}, edit, { after: pickAfter(d, edit.op === "add"), reason: $("#f-reason").value.trim(), editor, status, exported: false });
    } else {
      const cur = form.mode === "add" ? null : state.entries[form.targetId];
      edit = {
        edit_id: U.newEditId(),
        op: form.mode === "add" ? "add" : "update",
        target_id: form.mode === "add" ? nextUid() : form.targetId,
        before: cur ? { ko_raw: cur.ko_raw, en_raw: cur.en_raw } : {},
        after: pickAfter(d, form.mode === "add", cur),
        reason: $("#f-reason").value.trim(),
        editor, created_at: U.nowKST(), status, exported: false,
      };
    }
    // 기존 편집과 함께 적용해도 문제가 없는지 미리 확인
    const list = form.editId ? state.local.map((x) => (x.edit_id === edit.edit_id ? edit : x)) : state.local.concat([edit]);
    const probe = C.applyEdits(baseEntries(), list.map((x) => JSON.parse(JSON.stringify(x))), { onlyApproved: false });
    const bad = probe.conflicts.filter((c) => !state.conflicts.some((o) => o.edit_id === c.edit_id));
    if (bad.length) { setFormError([`저장할 수 없습니다: ${bad[0].reason} (${bad[0].edit_id})`]); return; }
    $("#form-dialog").close();
    await saveEdit(edit);
    toast(form.mode === "add" ? `${edit.target_id} 추가했습니다` : `${edit.target_id} 수정했습니다`);
    if (form.mode === "add") { $("#q").value = C.expandKo(d.ko_raw, d.paren_types).forms[0]; runSearch(); }
    if ($("#list-dialog").open) openChanges();
  }
  function pickAfter(d, isAdd, cur) {
    if (isAdd) return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== ""));
    const after = {};
    for (const k of ["ko_raw", "en_raw", "paren_types", "definition", "source_note"]) {
      const was = cur ? cur[k] : undefined;
      if (cur === undefined || JSON.stringify(d[k] ?? null) !== JSON.stringify(was ?? null)) after[k] = d[k];
    }
    return after;
  }
  function baseEntries() {
    const out = {};
    for (const raw of state.base.entries) out[raw.id] = C.inflate(JSON.parse(JSON.stringify(raw)));
    return out;
  }

  // ------------------------------------------------------------ 편집: 삭제·복원
  let deleteTarget = null;
  function openDelete(id) {
    deleteTarget = state.entries[id];
    $("#delete-target").textContent = `${deleteTarget.id}  ${deleteTarget.ko_primary} / ${deleteTarget.en}`;
    $("#d-reason").value = "";
    $("#delete-dialog").showModal();
    $("#d-reason").focus();
  }
  async function submitDelete(ev) {
    ev.preventDefault();
    const reason = $("#d-reason").value.trim();
    if (!reason) { $("#d-reason").focus(); return; }
    const e = deleteTarget;
    const edit = {
      edit_id: U.newEditId(), op: "delete", target_id: e.id,
      before: { ko_raw: e.ko_raw, en_raw: e.en_raw }, after: {}, reason,
      editor: await editorName(), created_at: U.nowKST(), status: "approved", exported: false,
    };
    $("#delete-dialog").close();
    await saveEdit(edit);
    toast(`${e.id} 삭제했습니다`, { label: "되돌리기", run: async () => { await S.remove(edit.edit_id); state.local = await S.list(); rebuild(); rerender(); toast("삭제를 취소했습니다"); } });
  }
  async function restore(id) {
    const e = state.entries[id];
    const localDelete = state.local.find((x) => x.op === "delete" && x.target_id === id && !x.exported);
    if (localDelete && state.local.filter((x) => x.target_id === id).slice(-1)[0] === localDelete) {
      await S.remove(localDelete.edit_id); // 아직 내보내지 않은 삭제는 기록을 지우는 것으로 충분
    } else {
      await S.put({
        edit_id: U.newEditId(), op: "restore", target_id: id,
        before: { ko_raw: e.ko_raw, en_raw: e.en_raw }, after: {}, reason: "복원",
        editor: await editorName(), created_at: U.nowKST(), status: "approved", exported: false,
      });
    }
    state.local = await S.list();
    rebuild();
    rerender();
    toast(`${id} 복원했습니다`);
  }

  // ------------------------------------------------------------ 목록 화면
  function openList(title, html) {
    $("#list-title").textContent = title;
    $("#list-body").innerHTML = html;
    if (!$("#list-dialog").open) $("#list-dialog").showModal();
  }
  function diff(a, b) {
    if (a === undefined || a === b) return esc(b ?? a ?? "");
    return `<del>${esc(a || "")}</del> → <ins>${esc(b ?? "")}</ins>`;
  }
  function openChanges() {
    const rows = activeLocal().map((e) => {
      const b = e.before || {}, a = e.after || {};
      const detail = e.op === "add" ? `${esc(a.ko_raw)} / <span lang="en">${esc(a.en_raw)}</span>`
        : e.op === "update" ? Object.keys(a).map((k) => `${FIELD_LABEL[k] || k}: ${diff(k in b ? b[k] : undefined, Array.isArray(a[k]) ? a[k].join(";") : a[k])}`).join("<br>")
        : `${esc(b.ko_raw)} / <span lang="en">${esc(b.en_raw)}</span>`;
      const conflict = state.conflicts.find((c) => c.edit_id === e.edit_id);
      return `<tr>
        <td>${OP_LABEL[e.op]}${e.exported ? "" : ' <span class="badge badge-updated">미내보냄</span>'}${conflict ? ` <span class="badge badge-deleted" title="${esc(conflict.reason)}">충돌</span>` : ""}</td>
        <td>${esc(e.target_id)}</td>
        <td class="diff">${detail}${e.reason ? `<br><span class="muted">사유: ${esc(e.reason)}</span>` : ""}</td>
        <td>${esc(e.created_at.slice(0, 16).replace("T", " "))}<br><span class="muted">${esc(e.editor || "")}</span></td>
        <td class="acts">
          <button type="button" class="btn btn-sm" data-action="toggle-status" data-edit="${e.edit_id}">${e.status === "approved" ? "승인됨" : "초안"}</button>
          ${e.op === "add" || e.op === "update" ? `<button type="button" class="btn btn-sm" data-action="edit-edit" data-edit="${e.edit_id}">고치기</button>` : ""}
          <button type="button" class="btn btn-sm" data-action="cancel-edit" data-edit="${e.edit_id}">취소</button>
        </td></tr>`;
    }).join("");
    const conflicts = state.conflicts.length
      ? `<p class="conflicts">적용되지 않은 편집 ${state.conflicts.length}건: ${state.conflicts.map((c) => `${esc(c.edit_id)} (${esc(c.reason)})`).join("; ")}</p>` : "";
    openList("변경사항", `${conflicts}
      <p class="hint">'승인됨' 편집만 빌드에 반영됩니다. 이 버튼을 누르면 승인됨과 초안이 서로 바뀝니다. 내보낸 파일은 <code>scripts/merge_edits.py</code>로 저장소에 합칩니다.</p>
      ${rows ? `<div class="table-wrap"><table class="changes"><thead><tr><th>연산</th><th>대상</th><th>내용</th><th>시각·편집자</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="empty">아직 변경사항이 없습니다. 검색 결과의 수정·삭제 버튼이나 새 용어 추가로 시작하세요.</p>'}
      <div class="dialog-actions" style="margin-top:12px">
        ${rows ? '<button type="button" class="btn" data-action="clear-exported">내보낸 편집 정리</button><button type="button" class="btn btn-solid" data-action="export">내보내기</button>' : ""}
      </div>`);
  }
  function openDeleted() {
    const list = Object.values(state.entries).filter((e) => e.status === "deleted")
      .sort((a, b) => a.id.localeCompare(b.id));
    const rows = list.map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.ko_raw)}<br><span lang="en">${esc(e.en_raw)}</span></td>
      <td>${esc(e.delete_reason || "")}</td>
      <td class="acts"><button type="button" class="btn btn-sm" data-action="restore" data-id="${e.id}">복원</button></td></tr>`).join("");
    openList("삭제된 용어", rows
      ? `<div class="table-wrap"><table class="changes"><thead><tr><th>id</th><th>원문</th><th>삭제 사유</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty">삭제된 용어가 없습니다.</p>');
  }

  async function doExport() {
    const edits = activeLocal();
    if (!edits.length) { toast("내보낼 변경사항이 없습니다"); return; }
    const payload = U.exportPayload(edits);
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `edits-${payload.exported_at.slice(0, 19).replace(/[-:T]/g, "")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    await S.putMany(edits.map((e) => Object.assign({}, e, { exported: true })));
    state.local = await S.list();
    updateEditSummary();
    toast(`${edits.length}건 내보냈습니다`);
    if ($("#list-dialog").open && $("#list-title").textContent === "변경사항") openChanges();
  }
  async function doImport(file) {
    try {
      const edits = U.parseImport(await file.text());
      const have = new Set(state.local.map((e) => e.edit_id));
      const fresh = edits.filter((e) => !have.has(e.edit_id) && !state.appliedIds.has(e.edit_id));
      await S.putMany(fresh);
      state.local = await S.list();
      rebuild();
      rerender();
      toast(`${fresh.length}건 가져왔습니다 (${edits.length - fresh.length}건은 이미 있음)`);
    } catch (err) {
      toast("가져오지 못했습니다: " + err.message);
    }
  }

  // ------------------------------------------------------------ 이벤트
  async function onAction(btn) {
    const act = btn.dataset.action;
    const id = btn.dataset.id;
    const editId = btn.dataset.edit;
    if (act === "new") {
      const pre = btn.dataset.prefill || "";
      openForm({ mode: "add", values: hasHangul(pre) ? { ko_raw: pre } : { en_raw: pre } });
    } else if (act === "edit") {
      const e = state.entries[id];
      openForm({ mode: "update", targetId: id, values: e });
    } else if (act === "delete") openDelete(id);
    else if (act === "restore") { await restore(id); openDeleted(); }
    else if (act === "changes") openChanges();
    else if (act === "deleted") openDeleted();
    else if (act === "export") doExport();
    else if (act === "import") $("#import-file").click();
    else if (act === "toggle-status") {
      const e = state.local.find((x) => x.edit_id === editId);
      await S.put(Object.assign({}, e, { status: e.status === "approved" ? "draft" : "approved", exported: false }));
      state.local = await S.list(); rebuild(); rerender(); openChanges();
    } else if (act === "cancel-edit") {
      const e = state.local.find((x) => x.edit_id === editId);
      const later = state.local.filter((x) => x.target_id === e.target_id && x.created_at > e.created_at);
      if (later.length && !confirm(`${e.target_id}에 이후 편집 ${later.length}건이 있습니다. 함께 취소할까요?`)) return;
      await S.removeMany([e.edit_id, ...later.map((x) => x.edit_id)]);
      state.local = await S.list(); rebuild(); rerender(); openChanges();
      toast("편집을 취소했습니다");
    } else if (act === "edit-edit") {
      const e = state.local.find((x) => x.edit_id === editId);
      // 이 편집을 적용하기 직전 상태를 기준으로 폼을 채운다
      const map = baseEntries();
      const prior = state.local.filter((x) => x.created_at < e.created_at).map((x) => JSON.parse(JSON.stringify(x)));
      C.applyEdits(map, prior, { onlyApproved: false });
      const base = e.op === "add" ? {} : map[e.target_id];
      const values = Object.assign({}, base, e.after);
      $("#list-dialog").close();
      openForm({ mode: e.op === "add" ? "add" : "update", targetId: e.target_id, editId: e.edit_id,
        values, reason: e.reason, editor: e.editor, status: e.status, original: e.op === "add" ? {} : base });
    } else if (act === "clear-exported") {
      const ids = state.local.filter((e) => e.exported).map((e) => e.edit_id);
      if (!ids.length) { toast("정리할 편집이 없습니다"); return; }
      if (!confirm(`내보낸 편집 ${ids.length}건을 이 브라우저에서 지웁니다. 저장소에 반영하기 전이라면 미리보기에서 사라집니다. 계속할까요?`)) return;
      await S.removeMany(ids);
      state.local = await S.list(); rebuild(); rerender(); openChanges();
    }
  }

  function bind() {
    const debounced = debounce(runSearch, 150);
    $("#q").addEventListener("input", debounced);
    $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
    document.querySelectorAll("[data-dir]").forEach((b) => {
      if (b.closest(".dir")) b.addEventListener("click", () => {
        state.dir = b.dataset.dir;
        document.querySelectorAll(".dir button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        runSearch();
      });
    });
    document.querySelectorAll("[data-index]").forEach((b) => b.addEventListener("click", () => {
      state.browse.kind = b.dataset.index;
      if (state.browse.letter) state.browse.letter = (state.browse.kind === "en" ? EN_LETTERS : KO_LETTERS)[0];
      renderLetters();
      if (state.browse.letter) { $("#q").value = ""; showBrowse(); }
    }));
    $("#letters").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-letter]");
      if (!b) return;
      $("#q").value = "";
      setLetter(b.dataset.letter);
      showBrowse();
    });
    $("#more").addEventListener("click", renderMore);
    document.body.addEventListener("click", async (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) {
        try { await navigator.clipboard.writeText(copy.dataset.copy); toast(`'${copy.dataset.copy}' 복사했습니다`); }
        catch { toast("복사하지 못했습니다. 직접 선택해 복사하세요."); }
        return;
      }
      const s = e.target.closest("[data-search]");
      if (s) {
        $("#q").value = s.dataset.search;
        if (s.dataset.dir) {
          state.dir = s.dataset.dir;
          document.querySelectorAll(".dir button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.dir === state.dir)));
        }
        runSearch();
        window.scrollTo({ top: 0 });
        return;
      }
      const a = e.target.closest("[data-action]");
      if (a) { onAction(a); return; }
      const close = e.target.closest("[data-close]");
      if (close) close.closest("dialog").close();
    });
    $("#edit-toggle").addEventListener("change", (e) => setEditMode(e.target.checked));
    $("#term-form").addEventListener("submit", submitForm);
    const onFormInput = (e) => {
      const sel = e.target.closest && e.target.closest("select[data-paren]");
      if (sel) form.types[+sel.dataset.paren] = sel.value;
      refreshPreview();
    };
    $("#term-form").addEventListener("input", onFormInput);
    $("#term-form").addEventListener("change", onFormInput);
    $("#delete-form").addEventListener("submit", submitDelete);
    $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ""; });
    window.addEventListener("beforeunload", (e) => {
      if (state.local.some((x) => !x.exported)) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  async function init() {
    bind();
    try {
      await load();
    } catch (err) {
      $("#status").textContent = err.message + " 로컬에서는 'python -m http.server -d web'으로 실행하세요.";
      return;
    }
    const params = new URLSearchParams(location.search);
    renderLetters();
    if (params.get("mode") === "edit") setEditMode(true);
    if (params.get("q")) $("#q").value = params.get("q");
    runSearch();
  }
  init();
})();
