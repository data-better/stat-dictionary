/* 편집 기록 저장소 (IndexedDB). 브라우저에만 저장되며, 내보내기 후 저장소에 반영한다. */
(function (root) {
  "use strict";
  const DB_NAME = "stat-dict";
  const DB_VERSION = 1;
  let dbPromise = null;
  let memory = null; // IndexedDB를 쓸 수 없을 때(사생활 보호 모드 등) 대체 저장소

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!("indexedDB" in root)) { memory = { edits: new Map(), settings: new Map() }; return resolve(null); }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("edits")) db.createObjectStore("edits", { keyPath: "edit_id" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { memory = { edits: new Map(), settings: new Map() }; resolve(null); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then((db) => {
      if (!db) return fn(null, memory[store]);
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s, null)).then((r) => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
      });
    });
  }
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  const EditStore = {
    isPersistent: () => open().then((db) => !!db),
    list: () => tx("edits", "readonly", (s, m) => (m ? [...m.values()] : wrap(s.getAll())))
      .then((arr) => arr.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || a.edit_id.localeCompare(b.edit_id))),
    put: (edit) => tx("edits", "readwrite", (s, m) => (m ? m.set(edit.edit_id, edit) : s.put(edit))),
    putMany: (edits) => tx("edits", "readwrite", (s, m) => edits.forEach((e) => (m ? m.set(e.edit_id, e) : s.put(e)))),
    remove: (id) => tx("edits", "readwrite", (s, m) => (m ? m.delete(id) : s.delete(id))),
    removeMany: (ids) => tx("edits", "readwrite", (s, m) => ids.forEach((id) => (m ? m.delete(id) : s.delete(id)))),
    getSetting: (k) => tx("settings", "readonly", (s, m) => (m ? m.get(k) : wrap(s.get(k)))),
    setSetting: (k, v) => tx("settings", "readwrite", (s, m) => (m ? m.set(k, v) : s.put(v, k))),
  };

  function pad(n, w) { return String(n).padStart(w || 2, "0"); }
  /** 한국 표준시 ISO 문자열 (밀리초 포함) */
  function nowKST() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:` +
      `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+09:00`;
  }
  /** 브라우저가 달라도 겹치지 않도록 시각 + 난수로 편집 id를 만든다. */
  function newEditId() {
    const t = nowKST();
    const rand = Math.random().toString(36).slice(2, 6);
    return `e${t.slice(0, 10).replace(/-/g, "")}-${t.slice(11, 19).replace(/:/g, "")}${t.slice(20, 23)}-${rand}`;
  }

  function exportPayload(edits) {
    const FIELDS = ["edit_id", "op", "target_id", "before", "after", "reason", "editor", "created_at", "status"];
    return {
      version: 1,
      exported_at: nowKST(),
      edits: edits.map((e) => Object.fromEntries(FIELDS.map((k) => [k, e[k] === undefined ? null : e[k]]))),
    };
  }

  function parseImport(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.edits;
    if (!Array.isArray(list)) throw new Error("edits 목록이 없는 파일입니다");
    const ok = [];
    for (const e of list) {
      if (!e || !e.edit_id || !["add", "update", "delete", "restore"].includes(e.op) || !e.target_id) {
        throw new Error("형식이 맞지 않는 편집 기록이 있습니다: " + JSON.stringify(e).slice(0, 80));
      }
      ok.push(Object.assign({ before: {}, after: {}, status: "approved" }, e, { exported: true }));
    }
    return ok;
  }

  root.EditStore = EditStore;
  root.EditUtil = { nowKST, newEditId, exportPayload, parseImport };
})(typeof self !== "undefined" ? self : this);
