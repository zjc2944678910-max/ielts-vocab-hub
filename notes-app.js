(() => {
  "use strict";

  const API = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
  const attr = value => esc(value).replace(/`/g, "&#96;");
  const state = {
    notebooks: [], notes: [], activeNotebook: "", activeNote: null,
    query: "", loaded: false, loading: false, dirty: false, saving: false,
    saveTimer: null, savePromise: null, editRevision: 0,
    selectionToken: 0, pendingNoteId: "", creatingPromise: null,
    noteCache: new Map(), noteLoads: new Map(),
    searchTimer: null, previewTimer: null, previewToken: 0,
    dialog: null, accountChecked: false,
    refreshedAt: 0
  };

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || `请求失败 (${response.status})`);
      error.code = data.error?.type || "request_failed";
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message) { window.VocabAtelier?.toast(message); }

  function bytesLabel(bytes) {
    const mb = Number(bytes || 0) / 1_000_000;
    return mb < .1 ? `${Math.round(Number(bytes || 0) / 1000)} KB` : `${mb.toFixed(1)} MB`;
  }

  function closeDialog(value = null) {
    if (!state.dialog) return;
    const { element, resolve } = state.dialog;
    state.dialog = null;
    element.remove();
    resolve(value);
  }

  function openDialog({ title, description = "", body = "", actions = [] }) {
    if (state.dialog) closeDialog(null);
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "note-dialog-overlay";
      overlay.innerHTML = `<section class="note-dialog" role="dialog" aria-modal="true"><header><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div><button class="icon-button" data-dialog-close aria-label="关闭">×</button></header><div class="note-dialog-body">${body}</div><footer>${actions.map((action, index) => `<button class="${attr(action.className || "secondary")}" data-dialog-action="${index}">${esc(action.label)}</button>`).join("")}</footer></section>`;
      document.body.appendChild(overlay);
      state.dialog = { element: overlay, resolve };
      overlay.addEventListener("click", event => {
        if (event.target === overlay || event.target.closest("[data-dialog-close]")) closeDialog(null);
        const button = event.target.closest("[data-dialog-action]");
        if (button) closeDialog(actions[Number(button.dataset.dialogAction)]?.value ?? null);
      });
      overlay.querySelector(".note-dialog")?.addEventListener("keydown", event => { if (event.key === "Escape") closeDialog(null); });
      overlay.querySelector("button, input")?.focus();
    });
  }

  function renderUsage(usage = {}) {
    const el = $("#notes-usage");
    if (el) el.textContent = `${usage.notes || 0} 篇 · ${bytesLabel(usage.bytes || 0)} / 100 MB`;
  }

  function renderNotebooks() {
    const box = $("#notes-notebook-list");
    if (!box) return;
    box.innerHTML = `<button class="notebook-button ${!state.activeNotebook ? "active" : ""}" data-notebook-id="">全部</button>` + state.notebooks.map(book => `<span class="notebook-entry"><button class="notebook-button ${state.activeNotebook === book.id ? "active" : ""}" data-notebook-id="${attr(book.id)}">${esc(book.name)} · ${book.note_count || 0}</button>${book.id !== "default-notebook" ? `<button class="notebook-menu" data-notebook-menu="${attr(book.id)}" aria-label="管理 ${attr(book.name)}">⋯</button>` : ""}</span>`).join("");
  }

  function renderNoteList() {
    const box = $("#note-list");
    if (!box) return;
    const selectedId = state.pendingNoteId || state.activeNote?.id;
    box.innerHTML = state.notes.length ? state.notes.map(note => `<button class="note-list-item ${selectedId === note.id ? "active" : ""} ${state.pendingNoteId === note.id ? "loading" : ""}" data-note-id="${attr(note.id)}" aria-busy="${state.pendingNoteId === note.id}"><b>${esc(note.title)}</b><span>${esc(note.excerpt || "空白笔记")}</span><small>${esc(note.notebook_name || "我的笔记")} · ${new Date(note.updated_at).toLocaleString("zh-CN", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit"})}</small></button>`).join("") : `<div class="empty-state">${state.query ? "没有匹配的笔记" : "这个笔记本还是空的"}</div>`;
  }

  function noteExcerpt(content) {
    return String(content || "").replace(/[#>*_`~-]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function mergeNoteIntoList(note, { prepend = false } = {}) {
    if (!note) return;
    if (Object.hasOwn(note, "content_md")) state.noteCache.set(note.id, note);
    const summary = { ...note, excerpt: noteExcerpt(note.content_md) };
    const index = state.notes.findIndex(item => item.id === note.id);
    if (index >= 0) state.notes[index] = { ...state.notes[index], ...summary };
    else if (prepend && (!state.activeNotebook || state.activeNotebook === note.notebook_id)) state.notes.unshift(summary);
    renderNoteList();
  }

  function setEditorEnabled(enabled) {
    ["#note-title", "#note-tags", "#note-content"].forEach(selector => { const el = $(selector); if (el) el.disabled = !enabled; });
    ["#export-note", "#delete-note", "[data-note-ai]"].forEach(selector => document.querySelectorAll(selector).forEach(el => { el.disabled = !enabled; }));
    $("#note-empty")?.classList.toggle("hidden", enabled);
    $("#note-editor-shell")?.classList.toggle("hidden", !enabled);
  }

  function renderPreview(source = $("#note-content")?.value || "") {
    const preview = $("#note-preview");
    if (!preview) return;
    preview.innerHTML = window.SafeMarkdown?.render ? window.SafeMarkdown.render(source, {preserveSoftBreaks:true}) : `<p>${esc(source)}</p>`;
  }

  function schedulePreview(source = $("#note-content")?.value || "", immediate = false) {
    const token = ++state.previewToken;
    clearTimeout(state.previewTimer);
    const commit = () => {
      if (token !== state.previewToken) return;
      renderPreview(source);
    };
    if (immediate || source.length < 4_000) requestAnimationFrame(commit);
    else state.previewTimer = setTimeout(() => (window.requestIdleCallback || requestAnimationFrame)(commit), 80);
  }

  function fillEditor(note) {
    state.activeNote = note;
    state.pendingNoteId = "";
    state.dirty = false;
    state.editRevision = 0;
    $("#note-title").value = note?.title || "";
    $("#note-tags").value = (note?.tags || []).join(", ");
    $("#note-content").value = note?.content_md || "";
    $("#note-save-status").textContent = note ? "已保存" : "选择或新建一篇笔记";
    setEditorEnabled(Boolean(note));
    schedulePreview(note?.content_md || "");
    renderNoteList();
  }

  async function refreshNotebooks() {
    const data = await api("/api/notebooks");
    state.notebooks = data.notebooks || [];
    renderUsage(data.usage);
    renderNotebooks();
  }

  async function refreshNotes({ keepSelection = true } = {}) {
    const params = new URLSearchParams();
    if (state.activeNotebook) params.set("notebook_id", state.activeNotebook);
    if (state.query) params.set("q", state.query);
    const data = await api(`/api/notes?${params}`);
    state.notes = data.notes || [];
    for (const note of state.notes) {
      const cached = state.noteCache.get(note.id);
      if (cached && (cached.version !== note.version || cached.updated_at !== note.updated_at)) state.noteCache.delete(note.id);
    }
    renderUsage(data.usage);
    renderNoteList();
    if (!keepSelection || (state.activeNote && !state.notes.some(note => note.id === state.activeNote.id))) fillEditor(null);
    state.notes.slice(0, 3).forEach(note => loadNote(note.id).catch(() => {}));
  }

  async function loadNote(id) {
    if (state.noteCache.has(id)) return state.noteCache.get(id);
    if (state.noteLoads.has(id)) return state.noteLoads.get(id);
    const request = api(`/api/notes/${encodeURIComponent(id)}`).then(data => {
      state.noteCache.set(id, data.note);
      return data.note;
    }).finally(() => {
      if (state.noteLoads.get(id) === request) state.noteLoads.delete(id);
    });
    state.noteLoads.set(id, request);
    return request;
  }

  async function activate({ force = false } = {}) {
    if (state.loading) return;
    if (!force && state.loaded && Date.now() - state.refreshedAt < 30_000) return;
    state.loading = true;
    try {
      await Promise.all([refreshNotebooks(), refreshNotes()]);
      state.loaded = true;
      state.refreshedAt = Date.now();
      await checkLegacyAccount();
    } catch (error) { toast(error.message); }
    finally { state.loading = false; }
  }

  function tagsFromInput() {
    return $("#note-tags").value.split(",").map(tag => tag.trim()).filter(Boolean).slice(0, 30);
  }

  function markDirty() {
    if (!state.activeNote || state.loading) return;
    state.dirty = true;
    state.editRevision += 1;
    $("#note-save-status").textContent = "等待保存…";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveActiveNote(), 700);
  }

  async function saveActiveNote({ quiet = false } = {}) {
    clearTimeout(state.saveTimer);
    while (state.savePromise) await state.savePromise;
    if (!state.activeNote || !state.dirty) return state.activeNote;
    const noteId = state.activeNote.id;
    const editRevision = state.editRevision;
    const payload = {
      version: state.activeNote.version,
      title: $("#note-title").value.trim() || "无标题笔记",
      tags: tagsFromInput(), content_md: $("#note-content").value,
      notebook_id: state.activeNote.notebook_id
    };
    let queueAnotherSave = false;
    state.saving = true;
    $("#note-save-status").textContent = "保存中…";
    const request = (async () => {
      try {
        const data = await api(`/api/notes/${noteId}`, { method: "PATCH", body: JSON.stringify(payload) });
        if (state.activeNote?.id === noteId) {
          state.activeNote = data.note;
          state.noteCache.set(noteId, data.note);
          mergeNoteIntoList(data.note);
          if (state.editRevision === editRevision) {
            state.dirty = false;
            $("#note-save-status").textContent = state.pendingNoteId ? "正在切换…" : "已保存";
          } else {
            state.dirty = true;
            queueAnotherSave = true;
            $("#note-save-status").textContent = "等待保存…";
          }
        }
        return data.note;
      } catch (error) {
        $("#note-save-status").textContent = error.status === 409 ? "版本冲突" : "保存失败";
        if (error.status === 409) {
          const action = await openDialog({ title: "这篇笔记已在别处修改", description: "为了避免覆盖另一标签页的内容，请先复制当前文字，再载入最新版本。", body: `<p>当前编辑内容仍保留在页面中。</p>`, actions: [{label:"继续编辑", value:"keep"}, {label:"复制并载入最新版", value:"reload", className:"primary"}] });
          if (action === "reload") {
            await navigator.clipboard.writeText($("#note-content").value).catch(() => {});
            const latest = await api(`/api/notes/${encodeURIComponent(noteId)}`);
            fillEditor(latest.note);
          }
        } else if (!quiet) toast(error.message);
        return null;
      }
    })();
    state.savePromise = request;
    try {
      return await request;
    } finally {
      if (state.savePromise === request) state.savePromise = null;
      state.saving = false;
      if (queueAnotherSave && state.activeNote?.id === noteId) {
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => saveActiveNote(), 250);
      }
    }
  }

  async function selectNote(id, { force = false } = {}) {
    if (!force && state.activeNote?.id === id && !state.pendingNoteId) return;
    const token = ++state.selectionToken;
    state.pendingNoteId = id;
    renderNoteList();
    $("#note-save-status").textContent = state.dirty || state.savePromise ? "先保存当前笔记…" : "正在切换…";
    const notePromise = loadNote(id);
    if ((state.dirty || state.savePromise) && !await saveActiveNote()) {
      if (token === state.selectionToken) { state.pendingNoteId = ""; renderNoteList(); }
      return;
    }
    if (token !== state.selectionToken) return;
    $("#note-save-status").textContent = "正在切换…";
    try {
      const note = await notePromise;
      if (token !== state.selectionToken) return;
      fillEditor(note);
      setMobileTab("edit");
    } catch (error) {
      if (token !== state.selectionToken) return;
      state.pendingNoteId = "";
      $("#note-save-status").textContent = state.dirty ? "等待保存…" : "已保存";
      renderNoteList();
      toast(error.message);
    }
  }

  async function createNote(payload = {}) {
    if (state.creatingPromise) return state.creatingPromise;
    const request = (async () => {
      if ((state.dirty || state.savePromise) && !await saveActiveNote()) return null;
      const isDefaultBlank = !Object.keys(payload).length;
      if (isDefaultBlank) {
        const existing = state.notes.find(note => note.title === "无标题笔记" && !note.excerpt?.trim() && !(note.tags || []).length && !note.source_filename);
        if (existing) {
          await selectNote(existing.id);
          $("#note-title").focus(); $("#note-title").select();
          toast("已打开现有空白笔记");
          return state.activeNote;
        }
      }
      try {
        const data = await api("/api/notes", { method: "POST", body: JSON.stringify({ notebook_id: state.activeNotebook || "default-notebook", title: "无标题笔记", content_md: "", tags: [], ...payload }) });
        mergeNoteIntoList(data.note, {prepend:true});
        state.noteCache.set(data.note.id, data.note);
        fillEditor(data.note);
        setMobileTab("edit");
        $("#note-title").focus(); $("#note-title").select();
        refreshNotebooks().catch(() => {});
        if (data.reused) toast("已打开现有空白笔记");
        return data.note;
      } catch (error) { toast(error.message); return null; }
    })();
    state.creatingPromise = request;
    document.querySelectorAll("#new-note,#empty-new-note").forEach(button => button.disabled = true);
    try { return await request; }
    finally {
      if (state.creatingPromise === request) state.creatingPromise = null;
      document.querySelectorAll("#new-note,#empty-new-note").forEach(button => button.disabled = false);
    }
  }

  async function deleteActiveNote() {
    const note = state.activeNote;
    if (!note || !confirm(`确定永久删除“${note.title}”吗？`)) return;
    const currentIndex = state.notes.findIndex(item => item.id === note.id);
    const nextSummary = state.notes[currentIndex + 1] || state.notes[currentIndex - 1] || null;
    const nextPromise = nextSummary ? loadNote(nextSummary.id).catch(() => null) : Promise.resolve(null);
    const deleteButton = $("#delete-note");
    if (deleteButton) deleteButton.disabled = true;
    $("#note-save-status").textContent = "正在删除…";
    try {
      const [, nextNote] = await Promise.all([
        api(`/api/notes/${note.id}`, { method: "DELETE" }),
        nextPromise
      ]);
      state.noteCache.delete(note.id);
      state.noteLoads.delete(note.id);
      state.notes = state.notes.filter(item => item.id !== note.id);
      if (nextNote) fillEditor(nextNote);
      else { fillEditor(null); renderNoteList(); }
      state.refreshedAt = Date.now();
      refreshNotebooks().catch(() => {});
      toast("笔记已删除");
    } catch (error) { $("#note-save-status").textContent = "删除失败"; toast(error.message); }
    finally { if (deleteButton && state.activeNote) deleteButton.disabled = false; }
  }

  async function createNotebook() {
    const name = prompt("新笔记本名称");
    if (!name?.trim()) return;
    try {
      const data = await api("/api/notebooks", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      state.activeNotebook = data.notebook.id;
      await Promise.all([refreshNotebooks(), refreshNotes({keepSelection:false})]);
    } catch (error) { toast(error.message); }
  }

  async function manageNotebook(id) {
    const book = state.notebooks.find(item => item.id === id); if (!book) return;
    const action = await openDialog({ title: book.name, description: `${book.note_count || 0} 篇笔记`, actions: [{label:"取消", value:null}, {label:"重命名", value:"rename"}, {label:"删除笔记本", value:"delete", className:"secondary danger-text"}] });
    if (action === "rename") {
      const name = prompt("新的笔记本名称", book.name); if (!name?.trim()) return;
      try { await api(`/api/notebooks/${id}`, {method:"PATCH", body:JSON.stringify({name:name.trim()})}); await refreshNotebooks(); }
      catch (error) { toast(error.message); }
    }
    if (action === "delete" && confirm(`删除“${book.name}”笔记本？其中的笔记会移入“我的笔记”。`)) {
      try { await api(`/api/notebooks/${id}`, {method:"DELETE"}); state.activeNotebook = ""; await Promise.all([refreshNotebooks(), refreshNotes()]); }
      catch (error) { toast(error.message); }
    }
  }

  async function readMarkdownFile(file) {
    if (file.size > 2_000_000) throw new Error(`${file.name} 超过 2 MB`);
    const buffer = await file.arrayBuffer();
    let content;
    try { content = new TextDecoder("utf-8", {fatal:true}).decode(buffer); }
    catch { throw new Error(`${file.name} 不是有效的 UTF-8 文档`); }
    return { name: file.name, content };
  }

  async function importMarkdown(files) {
    if (!files?.length) return;
    try {
      const all = await Promise.all([...files].map(readMarkdownFile));
      let totals = { created: 0, updated: 0, skipped: 0 };
      for (let index = 0; index < all.length;) {
        const batch = []; let size = 0;
        while (index < all.length && batch.length < 25) {
          const itemSize = new TextEncoder().encode(all[index].content).length;
          if (batch.length && size + itemSize > 3_500_000) break;
          batch.push(all[index++]); size += itemSize;
        }
        const previewData = await api("/api/notes/import/preview", {method:"POST", body:JSON.stringify({files:batch})});
        const updates = (previewData.preview?.files || []).filter(item => item.status === "update");
        let confirmUpdates = false;
        if (updates.length) {
          confirmUpdates = confirm(`${updates.length} 篇为本应用导出的同 ID 笔记，确认用导入版本更新原笔记吗？更新前会保存历史版本。`);
        }
        const result = await api("/api/notes/import", {method:"POST", body:JSON.stringify({files:batch, confirm_updates:confirmUpdates})});
        for (const key of Object.keys(totals)) totals[key] += Number(result.imported?.[key] || 0);
      }
      await Promise.all([refreshNotebooks(), refreshNotes()]);
      toast(`导入完成：新建 ${totals.created}，更新 ${totals.updated}，跳过 ${totals.skipped}`);
    } catch (error) { toast(error.message); }
    finally { $("#notes-import").value = ""; }
  }

  async function download(path, fallbackName) {
    try {
      const response = await fetch(`${API}${path}`);
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || "导出失败"); }
      const disposition = response.headers.get("Content-Disposition") || "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = encoded ? decodeURIComponent(encoded) : fallbackName;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast(error.message); }
  }

  function setMobileTab(tab) {
    const shell = $(".notes-shell"); if (!shell) return;
    shell.classList.toggle("mobile-edit", tab === "edit");
    shell.classList.toggle("mobile-preview", tab === "preview");
    document.querySelectorAll("[data-note-mobile-tab]").forEach(button => button.classList.toggle("active", button.dataset.noteMobileTab === tab));
  }

  async function pickNotes(selectedIds = []) {
    if (!state.loaded) await activate();
    const allData = await api("/api/notes");
    const available = allData.notes || [];
    const selected = new Set(selectedIds);
    const body = `<div class="note-picker-list">${available.map(note => `<label><input type="checkbox" value="${attr(note.id)}" ${selected.has(note.id) ? "checked" : ""}><span><strong>${esc(note.title)}</strong><small>${esc(note.notebook_name || "我的笔记")}</small></span></label>`).join("") || `<p>还没有笔记。</p>`}</div>`;
    if (state.dialog) closeDialog(null);
    return new Promise(resolve => {
      const overlay = document.createElement("div"); overlay.className = "note-dialog-overlay";
      overlay.innerHTML = `<section class="note-dialog" role="dialog" aria-modal="true"><header><div><h2>选择 AI 参考笔记</h2><p>最多选择 20 篇；只会检索与问题相关的小节。</p></div><button class="icon-button" data-cancel>×</button></header>${body}<footer><button class="secondary" data-cancel>取消</button><button class="primary" data-confirm>确认选择</button></footer></section>`;
      document.body.appendChild(overlay);
      const done = value => { overlay.remove(); resolve(value); };
      overlay.addEventListener("click", event => {
        if (event.target === overlay || event.target.closest("[data-cancel]")) done(null);
        if (event.target.closest("[data-confirm]")) {
          const ids = [...overlay.querySelectorAll("input:checked")].slice(0,20).map(input => input.value);
          done(ids.map(id => available.find(note => note.id === id)).filter(Boolean).map(note => ({id:note.id, title:note.title})));
        }
      });
    });
  }

  async function askWithCurrentNote() {
    const note = await saveActiveNote(); if (!note || state.dirty) return;
    window.VocabAtelierAI?.startNoteChat?.(note);
  }

  async function generateDraft(operation) {
    const note = await saveActiveNote(); if (!note || state.dirty) return;
    const labels = {summarize:"总结", organize:"整理结构", polish:"润色", outline:"生成复习提纲"};
    const instruction = operation === "polish" ? prompt("可选：告诉 AI 希望的语气或修改重点", "保持原意，改得更清晰") : "";
    if (instruction === null) return;
    document.querySelectorAll("[data-note-ai]").forEach(button => button.disabled = true);
    $("#note-save-status").textContent = `AI 正在${labels[operation]}…`;
    let draftId = "";
    try {
      const response = await fetch(`${API}/api/notes/${note.id}/ai-drafts`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({operation, instruction})});
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || "AI 草稿生成失败"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "", draftText = "";
      while (true) {
        const {value, done} = await reader.read(); if (done) break;
        buffer += decoder.decode(value, {stream:true}); const blocks = buffer.split("\n\n"); buffer = blocks.pop() || "";
        for (const block of blocks) {
          const name = block.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
          const raw = block.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim(); if (!raw) continue;
          const data = JSON.parse(raw);
          if (name === "start" || name === "meta") draftId = data.draft_id || draftId;
          if (name === "delta") draftText += data.text || "";
          if (name === "done") { draftId = data.draft_id || draftId; draftText = data.content_md || draftText; }
          if (name === "error") throw new Error(data.message || "AI 草稿生成失败");
        }
      }
      if (!draftId || !draftText.trim()) throw new Error("模型没有生成可用的笔记正文，请重试或在设置中更换模型");
      await showDraftDiff(note, draftId, draftText, labels[operation]);
    } catch (error) {
      if (draftId) await api(`/api/note-ai-drafts/${draftId}`, {method:"DELETE"}).catch(() => {});
      toast(error.message);
    }
    finally {
      $("#note-save-status").textContent = state.dirty ? "等待保存…" : "已保存";
      document.querySelectorAll("[data-note-ai]").forEach(button => button.disabled = !state.activeNote);
    }
  }

  async function showDraftDiff(note, draftId, content, label) {
    const result = await openDialog({title:`AI ${label}草稿`, description:"原笔记尚未改变。选择一种方式后才会保存。", body:`<div class="note-diff"><section><strong>原文</strong><pre>${esc(note.content_md)}</pre></section><section><strong>AI 草稿</strong><pre>${esc(content)}</pre></section></div>`, actions:[{label:"取消",value:null},{label:"追加到原文",value:"append"},{label:"保存为新笔记",value:"new"},{label:"替换原文",value:"replace",className:"primary"}]});
    if (!result) { await api(`/api/note-ai-drafts/${draftId}`, {method:"DELETE"}).catch(() => {}); return; }
    try {
      const data = await api(`/api/note-ai-drafts/${draftId}/apply`, {method:"POST", body:JSON.stringify({confirm:true, version:note.version, mode:result})});
      await Promise.all([refreshNotebooks(), refreshNotes()]); fillEditor(data.note); toast("AI 草稿已按你的选择保存");
    } catch (error) {
      await api(`/api/note-ai-drafts/${draftId}`, {method:"DELETE"}).catch(() => {});
      toast(error.message); if (error.status === 409) await selectNote(note.id, {force:true});
    }
  }

  async function saveAssistantMessage(content) {
    if (!content?.trim()) return;
    if (!state.loaded) await activate();
    const options = state.notebooks.map(book => `<option value="${attr(book.id)}">${esc(book.name)}</option>`).join("");
    if (state.dialog) closeDialog(null);
    const overlay = document.createElement("div"); overlay.className = "note-dialog-overlay";
    overlay.innerHTML = `<section class="note-dialog" role="dialog" aria-modal="true"><header><div><h2>保存 AI 回复为笔记</h2><p>确认笔记本和标题后才会创建。</p></div><button class="icon-button" data-cancel>×</button></header><div class="form-grid"><label>标题<input id="assistant-note-title" maxlength="160" value="AI 学习记录"></label><label>笔记本<select id="assistant-note-book">${options}</select></label></div><footer><button class="secondary" data-cancel>取消</button><button class="primary" data-save>保存笔记</button></footer></section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", async event => {
      if (event.target === overlay || event.target.closest("[data-cancel]")) overlay.remove();
      if (event.target.closest("[data-save]")) {
        const title = overlay.querySelector("#assistant-note-title").value.trim() || "AI 学习记录";
        const notebookId = overlay.querySelector("#assistant-note-book").value || "default-notebook";
        const note = await createNote({title, notebook_id:notebookId, content_md:content, tags:["AI 助教"]});
        overlay.remove(); if (note) { window.VocabAtelier?.switchTab("notes"); toast("AI 回复已保存为笔记"); }
      }
    });
  }

  async function openNote(id) {
    window.VocabAtelier?.switchTab("notes");
    await activate(); await selectNote(id, {force:true});
  }

  async function checkLegacyAccount() {
    if (state.accountChecked) return; state.accountChecked = true;
    try {
      const account = await api("/api/account/status");
      if (!account.authenticated || account.identity_mode !== "access") return;
      const data = await api("/api/account/legacy-preview");
      if (!data.available) return;
      const action = await openDialog({title:"发现这台浏览器的旧学习数据", description:"迁移前会创建只读备份，旧空间不能被重复认领。", body:`<p>${esc(data.summary || "可以把旧的匿名数据合并到你的登录账户。")}</p>`, actions:[{label:"暂不迁移",value:null},{label:"查看并确认迁移",value:"claim",className:"primary"}]});
      if (action === "claim" && confirm("确认将旧匿名数据合并到当前登录账户吗？")) {
        const result = await api("/api/account/claim-legacy", {method:"POST", body:JSON.stringify({confirm:true})});
        toast(result.message || "旧数据已迁移"); location.reload();
      }
    } catch { /* local/private mode has no claim flow */ }
  }

  function bind() {
    $("#new-note")?.addEventListener("click", () => createNote());
    $("#empty-new-note")?.addEventListener("click", () => createNote());
    $("#new-notebook")?.addEventListener("click", createNotebook);
    $("#delete-note")?.addEventListener("click", deleteActiveNote);
    $("#toggle-notes-nav")?.addEventListener("click", () => {
      const shell = $(".notes-shell"); const collapsed = !shell.classList.contains("navigator-collapsed");
      shell.classList.toggle("navigator-collapsed", collapsed); localStorage.setItem("ielts_notes_nav_collapsed", String(collapsed));
      $("#toggle-notes-nav").textContent = collapsed ? "›" : "‹";
    });
    $("#notes-notebook-list")?.addEventListener("click", async event => {
      const menu = event.target.closest("[data-notebook-menu]"); if (menu) { await manageNotebook(menu.dataset.notebookMenu); return; }
      const button = event.target.closest("[data-notebook-id]"); if (!button) return;
      if (state.dirty && !await saveActiveNote()) return;
      state.activeNotebook = button.dataset.notebookId; await refreshNotes({keepSelection:false}); renderNotebooks();
    });
    $("#note-list")?.addEventListener("click", event => { const button = event.target.closest("[data-note-id]"); if (button) selectNote(button.dataset.noteId); });
    $("#notes-search")?.addEventListener("input", event => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(async () => { state.query = event.target.value.trim(); await refreshNotes({keepSelection:true}); }, 260); });
    ["#note-title", "#note-tags", "#note-content"].forEach(selector => $(selector)?.addEventListener("input", () => { markDirty(); if (selector === "#note-content") schedulePreview(); }));
    $("#notes-import")?.addEventListener("change", event => importMarkdown(event.target.files));
    $("#export-note")?.addEventListener("click", async () => { const note = await saveActiveNote() || state.activeNote; if (note) download(`/api/notes/export?note_id=${encodeURIComponent(note.id)}`, `${note.title}.md`); });
    $("#export-notes")?.addEventListener("click", () => download(`/api/notes/export${state.activeNotebook ? `?notebook_id=${encodeURIComponent(state.activeNotebook)}` : ""}`, "vocab-atelier-notes.zip"));
    document.querySelectorAll("[data-note-mobile-tab]").forEach(button => button.addEventListener("click", () => setMobileTab(button.dataset.noteMobileTab)));
    document.querySelectorAll("[data-note-ai]").forEach(button => button.addEventListener("click", () => button.dataset.noteAi === "ask" ? askWithCurrentNote() : generateDraft(button.dataset.noteAi)));
    const splitter = $("#note-splitter");
    splitter?.addEventListener("pointerdown", event => {
      const shell = $("#note-editor-shell"); splitter.setPointerCapture(event.pointerId); splitter.classList.add("dragging");
      const move = moveEvent => { const rect = shell.getBoundingClientRect(); const ratio = Math.min(.75, Math.max(.25, (moveEvent.clientX - rect.left) / rect.width)); shell.style.setProperty("--editor-width", `${ratio * 100}%`); };
      const up = () => { splitter.classList.remove("dragging"); splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); };
      splitter.addEventListener("pointermove", move); splitter.addEventListener("pointerup", up);
    });
    window.addEventListener("beforeunload", event => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
    window.addEventListener("hashchange", () => { if (location.hash === "#notes") activate(); });
  }

  window.VocabNotes = { activate, pickNotes, openNote, saveAssistantMessage, getNotes: () => state.notes.slice() };
  bind();
  const collapsed = localStorage.getItem("ielts_notes_nav_collapsed") === "true";
  $(".notes-shell")?.classList.toggle("navigator-collapsed", collapsed);
  if ($("#toggle-notes-nav")) $("#toggle-notes-nav").textContent = collapsed ? "›" : "‹";
  if (location.hash === "#notes") activate();
})();
