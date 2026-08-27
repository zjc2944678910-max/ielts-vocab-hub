(() => {
  "use strict";

  const API = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
  const TOPICS = [
    "Academic Adjectives", "Academic Connectors", "Academic Verbs",
    "Education & Employment", "Environment & Energy", "Globalisation & Economy",
    "Health & Wellbeing", "Law & Crime", "Media & Communication",
    "Science & Research", "Society & Culture", "Technology & AI",
    "Urbanisation & Transport", "General Vocabulary"
  ];
  const state = {
    configured: false, chats: [], activeChat: null, messages: [], personalWords: [],
    streaming: false, currentContext: null, migrated: false, linkedNotes: [],
    routing: { mode: "none", model: "", fallback: false, defaultMode: "smart_free", defaultModel: "", deepseek: false },
    modelCatalog: [],
    chatsRefreshedAt: 0, chatsRefreshPromise: null, chatSelectionToken: 0,
    chatCache: new Map(), chatLoads: new Map(), chatHtmlCache: new Map(), messageRenderFrame: 0,
    chatReconcileTimers: new Map(), chatReconcileAttempts: new Map()
  };
  const chatSidebarMedia = window.matchMedia("(min-width: 721px)");
  const chatSidebarPreference = () => localStorage.getItem("ielts_chat_history_collapsed") === "true";
  const pendingClassifications = new Map();
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
  const attr = value => esc(value).replace(/`/g, "&#96;");
  const norm = value => String(value || "").trim().toLowerCase();
  const hasChinese = value => /[\u3400-\u9fff]/.test(String(value || ""));
  const TASK_PROFILE_LABELS = {translation:"翻译",word_enrichment:"词条扩展",vocabulary_qa:"词汇问答",ielts_writing:"雅思写作",study_qa:"学习问答",note_tutor:"笔记助教"};
  const CHAT_MODEL_STORAGE_KEY = "ielts_chat_model_selection_v1";
  const CHAT_RECONCILE_MAX_ATTEMPTS = 40;

  function parseModelSelection(value) {
    const raw = String(value || "follow_global");
    return raw.startsWith("fixed_free:")
      ? {mode:"fixed_free", model:raw.slice("fixed_free:".length)}
      : {mode:["follow_global","smart_free","deepseek"].includes(raw) ? raw : "follow_global", model:""};
  }

  function selectionValue(selection) {
    return selection?.mode === "fixed_free" && selection.model ? `fixed_free:${selection.model}` : selection?.mode || "follow_global";
  }

  function readChatModelMap() {
    try {
      const value = JSON.parse(localStorage.getItem(CHAT_MODEL_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function chatPreferenceKey() { return state.activeChat?.id || "__draft__"; }
  function currentChatSelection() { return parseModelSelection(selectionValue(readChatModelMap()[chatPreferenceKey()])); }

  function saveChatSelection(selection) {
    const map = readChatModelMap();
    map[chatPreferenceKey()] = parseModelSelection(selectionValue(selection));
    try { localStorage.setItem(CHAT_MODEL_STORAGE_KEY, JSON.stringify(map)); } catch { /* localStorage is optional */ }
  }

  function migrateDraftSelection(chatId) {
    if (!chatId) return;
    const map = readChatModelMap();
    if (map.__draft__) map[chatId] = map.__draft__;
    delete map.__draft__;
    try { localStorage.setItem(CHAT_MODEL_STORAGE_KEY, JSON.stringify(map)); } catch { /* localStorage is optional */ }
  }

  function routeLabel(route = {}) {
    const model = route.actual_model || route.model || "";
    const task = TASK_PROFILE_LABELS[route.task_profile] || "";
    if (route.source === "free_model") return [route.selection_mode === "fixed_free" ? "指定免费" : "智能免费", task, model || "OpenRouter"].filter(Boolean).join(" · ");
    if (route.source === "fallback_model") return [route.fallback ? "DeepSeek 兜底" : "DeepSeek", task, model || "已配置模型"].filter(Boolean).join(" · ");
    return "";
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `请求失败 (${response.status})`);
    return data;
  }

  function showFormStatus(message, type = "") {
    const el = $("#api-form-status");
    el.textContent = message;
    el.className = `form-status ${type}`;
  }

  function openModal() { window.VocabAtelier?.switchTab("settings"); requestAnimationFrame(() => $("#settings-api")?.scrollIntoView({behavior:"smooth"})); }
  function closeModal() {}
  function openDrawer() { $("#word-drawer").classList.add("open"); $("#word-drawer").setAttribute("aria-hidden", "false"); }
  function closeDrawer() { $("#word-drawer").classList.remove("open"); $("#word-drawer").setAttribute("aria-hidden", "true"); }

  function renderModelSelectors() {
    const modelOption = model => `<option value="fixed_free:${attr(model.id)}">${model.recommended ? "推荐 · " : ""}${esc(model.name || model.id)}</option>`;
    const freeOptions = state.modelCatalog.filter(model => model.available).map(modelOption).join("");
    const chatProfiles = new Set(["vocabulary_qa","ielts_writing","study_qa","note_tutor"]);
    const chatFreeOptions = state.modelCatalog.filter(model => model.available && (model.task_profiles || []).some(profile => chatProfiles.has(profile))).map(modelOption).join("");
    const savedFixed = state.routing.defaultMode === "fixed_free" && state.routing.defaultModel && !state.modelCatalog.some(model => model.id === state.routing.defaultModel)
      ? `<option value="fixed_free:${attr(state.routing.defaultModel)}">${esc(state.routing.defaultModel)}</option>` : "";
    const deepseekOption = `<option value="deepseek" ${state.routing.deepseek ? "" : "disabled"}>DeepSeek${state.routing.deepseek ? "" : "（未配置）"}</option>`;
    const defaultSelect = $("#api-default-model");
    if (defaultSelect) {
      defaultSelect.innerHTML = `<option value="smart_free">智能免费</option>${savedFixed}${freeOptions ? `<optgroup label="固定免费模型">${freeOptions}</optgroup>` : ""}${deepseekOption}`;
      defaultSelect.value = state.routing.defaultMode === "fixed_free" ? `fixed_free:${state.routing.defaultModel}` : state.routing.defaultMode;
      if (!defaultSelect.value) defaultSelect.value = "smart_free";
    }
    const chatSelect = $("#chat-model-select");
    if (chatSelect) {
      const selection = currentChatSelection();
      const missingFixed = selection.mode === "fixed_free" && selection.model && !state.modelCatalog.some(model => model.id === selection.model)
        ? `<option value="fixed_free:${attr(selection.model)}">${esc(selection.model)}</option>` : "";
      chatSelect.innerHTML = `<option value="follow_global">跟随全局</option><option value="smart_free">智能免费</option>${missingFixed}${chatFreeOptions ? `<optgroup label="指定免费模型">${chatFreeOptions}</optgroup>` : ""}${deepseekOption}`;
      chatSelect.value = selectionValue(selection);
      if (!chatSelect.value) chatSelect.value = "follow_global";
      const status = $("#chat-model-status");
      if (status) status.textContent = selection.mode === "follow_global" ? "跟随全局设置" : selection.mode === "smart_free" ? "本对话自动按任务选择" : selection.mode === "deepseek" ? "本对话使用 DeepSeek" : `本对话固定：${selection.model}`;
    }
  }

  async function refreshModelCatalog() {
    try {
      const data = await api("/api/models");
      state.modelCatalog = Array.isArray(data.models) ? data.models : [];
    } catch { state.modelCatalog = []; }
    renderModelSelectors();
  }

  async function refreshConfig() {
    try {
      const config = await api("/api/config/status");
      state.configured = config.configured;
      state.routing = { mode: config.routing_mode || "none", model: config.model || "", fallback: Boolean(config.fallback_configured), defaultMode: config.default_mode || "smart_free", defaultModel: config.default_model || "", deepseek: Boolean(config.deepseek_configured) };
      $("#api-status-text").textContent = !config.configured ? "API 未配置" : config.default_mode === "deepseek" ? (config.manual_model || "DeepSeek") : config.default_mode === "fixed_free" ? (config.default_model || "固定免费模型") : "智能免费";
      $("#open-api-settings").classList.toggle("configured", config.configured);
      $("#api-openrouter-enabled").checked = Boolean(config.openrouter_configured);
      $("#api-base-url").value = config.manual_base_url || (config.routing_mode === "manual" ? config.base_url || "" : "");
      $("#api-model").value = config.manual_model || (config.routing_mode === "manual" ? config.model || "" : "");
      $("#api-openrouter-key").placeholder = config.openrouter_configured ? "已保存；留空表示不修改" : "输入 OpenRouter API Key";
      $("#api-key").placeholder = config.fallback_configured ? "已保存；留空表示不修改" : "输入备用模型 API Key";
      $("#openrouter-catalog-status").textContent = config.free_catalog_checked_at ? `免费目录已校验：${new Date(config.free_catalog_checked_at).toLocaleString("zh-CN")}` : "免费目录尚未校验；首次请求时自动检查";
      $("#fallback-config-status").textContent = config.fallback_configured ? `已配置：${config.manual_model || "DeepSeek"}` : "未配置";
      $("#default-model-status").textContent = config.default_mode === "deepseek" ? "所有 AI 任务默认使用 DeepSeek" : config.default_mode === "fixed_free" ? `所有 AI 任务优先使用 ${config.default_model}` : "自动按任务选择免费模型，必要时使用 DeepSeek 兜底";
      renderModelSelectors();
      if (config.openrouter_configured) refreshModelCatalog();
    } catch {
      state.configured = false;
      state.routing = { mode: "none", model: "", fallback: false, defaultMode: "smart_free", defaultModel: "", deepseek: false };
      state.modelCatalog = [];
      $("#api-status-text").textContent = "本地 API 未连接";
      $("#open-api-settings").classList.remove("configured");
      renderModelSelectors();
    }
  }

  function configPayload() {
    const selected = parseModelSelection($("#api-default-model").value);
    return {
      version: 3,
      default_mode: selected.mode,
      default_model: selected.model,
      openrouter: {
        enabled: Boolean($("#api-openrouter-enabled").checked),
        api_key: $("#api-openrouter-key").value.trim(),
      },
      manual: {
        base_url: $("#api-base-url").value.trim(),
        model: $("#api-model").value.trim(),
        api_key: $("#api-key").value.trim(),
      },
    };
  }

  function readStorageArray(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }

  const ROUTE_STORAGE_KEY = "ielts_chat_route_meta_v1";
  function readRouteMap() {
    try {
      const value = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function rememberRoute(messageId, routing) {
    if (!messageId || !routing?.source) return;
    const map = readRouteMap(); map[messageId] = {...routing};
    const keys = Object.keys(map);
    keys.slice(0, Math.max(0, keys.length - 200)).forEach(key => delete map[key]);
    try { localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(map)); } catch { /* localStorage is optional */ }
  }
  function hydrateRoutes(messages) {
    const map = readRouteMap();
    return (messages || []).map(message => message.routing || !map[message.id] ? message : {...message, routing: map[message.id]});
  }

  function preserveLegacyBackup() {
    if (localStorage.getItem("ielts_legacy_backup_v1")) return;
    const keys = ["ielts_saved_words", "ielts_mastered", "ielts_review", "ielts_discovered"];
    const values = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
    localStorage.setItem("ielts_legacy_backup_v1", JSON.stringify({ created_at: new Date().toISOString(), values }));
  }

  async function saveConfig(event) {
    event.preventDefault(); showFormStatus("正在保存…");
    try {
      await api("/api/config", { method: "POST", body: JSON.stringify(configPayload()) });
      $("#api-key").value = ""; $("#api-openrouter-key").value = ""; showFormStatus("配置已安全保存到你的个人空间。", "success"); await refreshConfig();
    } catch (error) { showFormStatus(error.message, "error"); }
  }

  async function testConfig() {
    showFormStatus("正在校验当前路由和模型目录…");
    try { const result = await api("/api/config/test", { method: "POST", body: JSON.stringify(configPayload()) }); showFormStatus(`连接成功：${routeLabel(result.routing) || result.model}`, "success"); await refreshConfig(); }
    catch (error) { showFormStatus(error.message, "error"); }
  }

  async function clearConfig() {
    if (!confirm("确定清除你的个人 API 配置吗？")) return;
    try { await api("/api/config", { method: "DELETE" }); $("#api-form").reset(); showFormStatus("配置已清除。", "success"); await refreshConfig(); }
    catch (error) { showFormStatus(error.message, "error"); }
  }

  function migrationWords() {
    const app = window.VocabAtelier;
    if (!app) return [];
    const saved = new Set(readStorageArray("ielts_saved_words").map(norm));
    const mastered = new Set(readStorageArray("ielts_mastered").map(norm));
    const review = new Set(readStorageArray("ielts_review").map(norm));
    const discovered = readStorageArray("ielts_discovered");
    const discoveredMap = new Map(discovered.map(item => [norm(item.word), item]));
    const referenced = new Set([...saved, ...mastered, ...review]);
    const result = discovered.map(item => {
      const key = norm(item.word);
      return { ...item, source: item.source || item._source || "legacy", saved: saved.has(key), status: mastered.has(key) ? "mastered" : review.has(key) ? "review" : "learning" };
    });
    for (const word of referenced) {
      if (discoveredMap.has(word)) continue;
      const source = app.getDataset().find(item => norm(item.word) === word);
      if (source) result.push({ ...source, source: "legacy", saved: saved.has(word), status: mastered.has(word) ? "mastered" : review.has(word) ? "review" : "learning" });
    }
    return result.slice(0, 5000);
  }

  async function migrateLegacy() {
    preserveLegacyBackup();
    if (localStorage.getItem("ielts_sqlite_migration_v1") === "complete") return;
    try {
      const words = migrationWords();
      await api("/api/migrate", { method: "POST", body: JSON.stringify({ words }) });
      localStorage.setItem("ielts_sqlite_migration_v1", "complete");
      state.migrated = true;
    } catch { /* Compatibility storage remains authoritative until API returns. */ }
  }

  async function refreshWords() {
    try {
      const data = await api("/api/words");
      state.personalWords = data.words || [];
      window.VocabAtelier?.mergePersonalWords(state.personalWords);
      state.personalWords.forEach(word => { if (word.saved) window.VocabAtelier?.setSaved(word.word, true); if (word.status !== "learning") window.VocabAtelier?.setStatus(word.word, word.status); });
    } catch { state.personalWords = []; }
  }

  async function classifyAndSave(item, announce = true, useAi = true) {
    const existing = state.personalWords.find(word => norm(word.word) === norm(item.word));
    if (existing) {
      const source = existing.source || existing._source;
      const incomingSource = item.source || item._source;
      if (source === "dictionary" && incomingSource === "cambridge" && !hasChinese(existing.definition) && hasChinese(item.definition)) {
        const fields = ["phonetic", "pos", "definition", "band", "synonyms", "antonyms", "collocations", "examples", "note"];
        const payload = Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]]));
        payload.note = item.note || item.paraphraseExamContext || "来自 Cambridge Dictionary 的中英词条。";
        payload.source = "cambridge";
        const data = await api(`/api/words/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        state.personalWords = [data.word, ...state.personalWords.filter(word => word.id !== data.word.id)];
        window.VocabAtelier?.mergePersonalWords(state.personalWords);
        if (announce) window.VocabAtelier?.toast(`${data.word.word} 的中文释义已更新`);
        return data.word;
      }
      return existing;
    }
    const key = norm(item.word);
    if (pendingClassifications.has(key)) return pendingClassifications.get(key);
    const request = (async () => {
      const data = await api("/api/words/classify", { method: "POST", body: JSON.stringify({ word_entry: { ...item, source: item.source || item._source || "lookup" }, use_ai: useAi }) });
      state.personalWords = [data.word, ...state.personalWords.filter(word => word.id !== data.word.id)];
      window.VocabAtelier?.mergePersonalWords(state.personalWords);
      if (announce) window.VocabAtelier?.toast(`${data.word.word} 已自动分类并加入个人词库`);
      return data.word;
    })();
    pendingClassifications.set(key, request);
    try { return await request; }
    catch (error) { if (announce) window.VocabAtelier?.toast(error.message); throw error; }
    finally { if (pendingClassifications.get(key) === request) pendingClassifications.delete(key); }
  }

  async function analyzeCurrentWord() {
    const item = window.VocabAtelier?.getCurrentWord();
    if (!item) return;
    if (!state.configured) { openModal(); showFormStatus("请先完成 API 配置。", "error"); return; }
    const target = $("#word-ai-analysis"); const button = $("[data-ai-analyze]");
    target.innerHTML = `<div class="ai-analysis"><p>AI 正在分析 ${esc(item.word)}…</p></div>`; button.disabled = true;
    try {
      const data = await api("/api/analyze", { method: "POST", body: JSON.stringify({ word_entry: item }) });
      const a = data.analysis;
      if (data.word) { state.personalWords = [data.word, ...state.personalWords.filter(word => word.id !== data.word.id)]; window.VocabAtelier?.mergePersonalWords(state.personalWords); }
      const route = routeLabel(data.routing || {});
      target.innerHTML = `<div class="ai-analysis"><h4>✦ AI 深度解析 · Band ${esc(a.band || "—")}${route ? ` <small class="message-route">${esc(route)}</small>` : ""}</h4><p><strong>${esc(a.definition || "")}</strong></p><p>${esc(a.note || "")}</p>${a.collocations?.length ? `<p>搭配：${a.collocations.map(esc).join(" · ")}</p>` : ""}${a.synonyms?.length ? `<p>同义替换：${a.synonyms.map(esc).join(" · ")}</p>` : ""}</div>`;
    } catch (error) { target.innerHTML = `<div class="ai-analysis"><h4>解析失败</h4><p>${esc(error.message)}</p></div>`; }
    finally { button.disabled = false; }
  }

  async function refreshChats(selectId = null, { force = false } = {}) {
    try {
      if (force || !state.chats.length || Date.now() - state.chatsRefreshedAt >= 30_000) {
        if (!state.chatsRefreshPromise) {
          state.chatsRefreshPromise = api("/api/chats").then(data => {
            state.chats = data.chats || [];
            state.chatsRefreshedAt = Date.now();
          }).finally(() => { state.chatsRefreshPromise = null; });
        }
        await state.chatsRefreshPromise;
      }
      renderChatList();
      if (state.activeChat?.draft && !selectId) { renderMessages(); updateChatHead(); return; }
      const desired = selectId || state.activeChat?.id || state.chats[0]?.id;
      if (desired) await selectChat(desired); else clearChatView();
      const idle = window.requestIdleCallback || (callback => setTimeout(callback, 80));
      state.chats.slice(0, 5).forEach(chat => loadChat(chat.id).then(cached => idle(() => {
        if (!state.chatHtmlCache.has(chat.id)) state.chatHtmlCache.set(chat.id, messagesHtml(cached.messages));
      })).catch(() => {}));
    } catch { state.chats = []; renderChatList(); clearChatView(); }
  }

  function renderChatList() {
    const draft = state.activeChat?.draft ? `<div class="chat-list-item chat-list-draft active"><b>${esc(state.activeChat.title)}</b><small>发送首条消息后保存</small></div>` : "";
    const saved = state.chats.map(chat => `<button class="chat-list-item ${state.activeChat?.id === chat.id ? "active" : ""}" data-chat-id="${attr(chat.id)}"><b>${esc(chat.title)}</b><small>${new Date(chat.updated_at).toLocaleString("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</small></button>`).join("");
    $("#chat-list").innerHTML = draft || saved ? draft + saved : `<div class="empty-state">还没有对话</div>`;
    const mobileDraft = state.activeChat?.draft ? `<option value="" selected>${esc(state.activeChat.title)}（未保存）</option>` : "";
    $("#mobile-chat-select").innerHTML = mobileDraft + (state.chats.length ? state.chats.map(chat => `<option value="${attr(chat.id)}" ${state.activeChat?.id === chat.id ? "selected" : ""}>${esc(chat.title)}</option>`).join("") : mobileDraft ? "" : `<option value="">暂无对话</option>`);
  }

  function createChat(context = null) {
    if (state.streaming) { window.VocabAtelier?.toast("请先停止当前回复"); return null; }
    if (state.activeChat?.draft && !context) { $("#chat-input").focus(); window.VocabAtelier?.toast("当前已经是空白对话"); return state.activeChat; }
    const preferences = readChatModelMap(); delete preferences.__draft__;
    try { localStorage.setItem(CHAT_MODEL_STORAGE_KEY, JSON.stringify(preferences)); } catch { /* localStorage is optional */ }
    state.activeChat = { id: null, title: context?.word ? `${context.word} 学习` : "新对话", current_context: context, draft: true };
    state.messages = []; state.currentContext = context; state.linkedNotes = []; renderChatList(); renderMessages(); updateChatHead(); renderChatNotes(); $("#chat-input").focus();
    return state.activeChat;
  }

  async function persistChatDraft() {
    if (!state.activeChat?.draft) return state.activeChat;
    const draft = state.activeChat;
    try {
      const data = await api("/api/chats", { method: "POST", body: JSON.stringify({ title: draft.title, current_context: draft.current_context }) });
      migrateDraftSelection(data.chat.id);
      state.chats = [data.chat, ...state.chats.filter(chat => chat.id !== data.chat.id)]; state.activeChat = data.chat; state.currentContext = data.chat.current_context || null; renderChatList(); updateChatHead();
      if (state.linkedNotes.length) await persistChatNotes();
      return data.chat;
    } catch (error) { window.VocabAtelier?.toast(error.message); return null; }
  }

  function hasGeneratingMessage(messages = []) {
    return messages.some(message => message.role === "assistant" && message.status === "generating" && !String(message.content || "").trim());
  }

  function clearChatReconcile(id) {
    const timer = state.chatReconcileTimers.get(id);
    if (timer) clearTimeout(timer);
    state.chatReconcileTimers.delete(id);
    state.chatReconcileAttempts.delete(id);
  }

  function scheduleChatReconcile(id) {
    if (!id || state.activeChat?.id !== id || state.streaming || state.chatReconcileTimers.has(id)) return;
    const cached = state.chatCache.get(id);
    if (!cached || !hasGeneratingMessage(cached.messages)) { clearChatReconcile(id); return; }
    const attempts = state.chatReconcileAttempts.get(id) || 0;
    if (attempts >= CHAT_RECONCILE_MAX_ATTEMPTS) {
      state.chatCache.delete(id);
      state.chatHtmlCache.delete(id);
      return;
    }
    const delay = Math.min(500 + attempts * 250, 3000);
    const timer = setTimeout(async () => {
      state.chatReconcileTimers.delete(id);
      if (state.activeChat?.id !== id || state.streaming) { state.chatReconcileAttempts.delete(id); return; }
      state.chatReconcileAttempts.set(id, attempts + 1);
      try {
        const data = await loadChat(id, { force: true });
        if (state.activeChat?.id !== id || state.streaming) return;
        state.messages = data.messages.map(message => ({...message}));
        state.linkedNotes = data.notes.map(note => ({...note}));
        renderMessages(); renderChatNotes();
      } catch { scheduleChatReconcile(id); }
    }, delay);
    state.chatReconcileTimers.set(id, timer);
  }

  async function loadChat(id, { force = false } = {}) {
    if (!force && state.chatCache.has(id)) {
      const cached = state.chatCache.get(id);
      if (hasGeneratingMessage(cached.messages)) scheduleChatReconcile(id); else clearChatReconcile(id);
      return cached;
    }
    if (!force && state.chatLoads.has(id)) return state.chatLoads.get(id);
    const request = api(`/api/chats/${id}/messages`).then(data => {
      const cached = { messages: hydrateRoutes(data.messages || []), notes: data.notes || [] };
      state.chatCache.set(id, cached);
      if (hasGeneratingMessage(cached.messages)) scheduleChatReconcile(id); else clearChatReconcile(id);
      return cached;
    }).finally(() => { if (state.chatLoads.get(id) === request) state.chatLoads.delete(id); });
    state.chatLoads.set(id, request);
    return request;
  }

  async function selectChat(id, { force = false } = {}) {
    const chat = state.chats.find(item => item.id === id); if (!chat) return;
    if (!state.chatCache.has(id) && !state.chatReconcileTimers.has(id)) state.chatReconcileAttempts.delete(id);
    if (!force && state.activeChat?.id === id && state.chatCache.has(id)) { scheduleChatReconcile(id); return; }
    const token = ++state.chatSelectionToken;
    state.activeChat = chat; state.currentContext = chat.current_context || null; renderChatList(); updateChatHead();
    const cached = !force && state.chatCache.get(id);
    if (cached) {
      state.messages = cached.messages.map(message => ({...message}));
      state.linkedNotes = cached.notes.map(note => ({...note}));
      renderMessages({ useCached: true }); renderChatNotes();
      scheduleChatReconcile(id);
      return;
    }
    try {
      if (force) { state.chatCache.delete(id); state.chatHtmlCache.delete(id); }
      const data = await loadChat(id);
      if (token !== state.chatSelectionToken) return;
      state.messages = data.messages.map(message => ({...message}));
      state.linkedNotes = data.notes.map(note => ({...note}));
      renderMessages({ useCached: true }); renderChatNotes();
    }
    catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  function updateChatHead() {
    $("#chat-title").textContent = state.activeChat?.title || "AI 学习助教";
    $("#chat-context").textContent = state.currentContext?.word ? `当前词条：${state.currentContext.word}` : "词义辨析、写作改写、例句与学习建议";
    $("#rename-chat").disabled = !state.activeChat?.id;
    $("#delete-chat").disabled = !state.activeChat?.id;
    const chip = $("#chat-context-chip");
    if (state.currentContext?.word) { chip.innerHTML = `正在参考词条：<strong>${esc(state.currentContext.word)}</strong><button data-clear-context>×</button>`; chip.classList.remove("hidden"); }
    else { chip.classList.add("hidden"); chip.innerHTML = ""; }
    renderModelSelectors();
  }

  function clearChatView() { state.activeChat = null; state.messages = []; state.currentContext = null; state.linkedNotes = []; renderMessages(); updateChatHead(); renderChatNotes(); }

  function renderChatNotes() {
    const box = $("#chat-note-chips"); if (!box) return;
    box.innerHTML = state.linkedNotes.map(note => `<span class="note-context-chip">${esc(note.title)}<button data-remove-chat-note="${attr(note.id)}" aria-label="移除 ${attr(note.title)}">×</button></span>`).join("");
  }

  async function persistChatNotes() {
    if (!state.activeChat?.id) return;
    const data = await api(`/api/chats/${state.activeChat.id}/notes`, {method:"PUT", body:JSON.stringify({note_ids:state.linkedNotes.map(note => note.id)})});
    state.linkedNotes = data.notes || []; renderChatNotes(); cacheActiveChat();
  }

  async function chooseChatNotes() {
    try {
      const selected = await window.VocabNotes?.pickNotes?.(state.linkedNotes.map(note => note.id));
      if (!selected) return;
      state.linkedNotes = selected; renderChatNotes();
      if (state.activeChat?.id) await persistChatNotes();
    } catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  function actionLabel(action) {
    if (action.type === "save_word") return `将 ${action.word} 加入生词本`;
    if (action.type === "review_word") return `将 ${action.word} 加入复习队列`;
    return `把 ${action.word} 分类为 ${action.category}`;
  }

  function messageHtml(message, index) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const actions = (message.actions || []).map((action, actionIndex) => `<div class="action-card" data-action-card><span>${esc(actionLabel(action))}</span><button data-confirm-action data-message-index="${index}" data-action-index="${actionIndex}">确认执行</button></div>`).join("");
    const waiting = role === "assistant" && message.status === "generating" && !message.content;
    const emptyReply = role === "assistant" && message.status !== "generating" && !message.content;
    const content = waiting
      ? `<span class="message-loading" role="status">正在生成…</span>`
      : emptyReply ? `<span class="message-empty">此回复没有可显示内容，请重新生成。</span>`
      : role === "assistant" && window.SafeMarkdown?.render ? window.SafeMarkdown.render(message.content || "", {citations: message.citations || []}) : esc(message.content || "");
    const citations = role === "assistant" && message.citations?.length ? `<div class="message-citations">${message.citations.map(source => `<button class="message-citation" data-open-note="${attr(source.note_id)}">[${esc(source.ref)}] ${esc(source.title)}${source.heading ? ` › ${esc(source.heading)}` : ""}</button>`).join("")}</div>` : "";
    const route = role === "assistant" && message.routing ? routeLabel(message.routing) : "";
    return `<article class="message ${role}"><div class="message-avatar">${role === "assistant" ? "AI" : "你"}</div><div class="message-content"><div class="message-role">${role === "assistant" ? "IELTS 助教" : "YOU"}</div>${route ? `<div class="message-route">${esc(route)}</div>` : ""}<div class="message-text${role === "assistant" ? " markdown" : ""}">${content}</div>${citations}${message.status && message.status !== "complete" && message.status !== "generating" ? `<div class="message-status">${message.status === "aborted" ? "生成已停止" : "生成未完成"}</div>` : ""}${actions ? `<div class="action-list">${actions}</div>` : ""}<div class="message-tools">${role === "assistant" && message.content ? `<button data-copy-message data-index="${index}">复制回复</button><button data-save-message-note data-index="${index}">保存为笔记</button>` : ""}</div></div></article>`;
  }

  function messagesHtml(messages = state.messages) {
    return messages.length ? messages.map(messageHtml).join("") : `<div class="chat-empty"><span>✦</span><h2>从一个具体问题开始</h2><p>例如：帮我区分 alleviate 和 mitigate，并各写一个雅思作文例句。</p></div>`;
  }

  function renderMessages({ useCached = false } = {}) {
    const box = $("#chat-messages");
    const chatId = state.activeChat?.id;
    const cachedHtml = useCached && chatId ? state.chatHtmlCache.get(chatId) : "";
    box.innerHTML = cachedHtml || messagesHtml();
    if (chatId) state.chatHtmlCache.set(chatId, box.innerHTML);
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  function scheduleMessagesRender() {
    if (state.messageRenderFrame) return;
    state.messageRenderFrame = requestAnimationFrame(() => {
      state.messageRenderFrame = 0;
      renderMessages();
    });
  }

  function cacheActiveChat() {
    const id = state.activeChat?.id;
    if (!id) return;
    state.chatCache.set(id, {
      messages: state.messages.map(message => ({...message})),
      notes: state.linkedNotes.map(note => ({...note}))
    });
  }

  async function sendChat(event, regenerate = false) {
    if (event) event.preventDefault(); if (state.streaming) return;
    if (!state.configured) { openModal(); showFormStatus("请先完成 API 配置。", "error"); return; }
    const input = $("#chat-input"); const content = input.value.trim(); if (!regenerate && !content) return;
    if (!state.activeChat && !createChat(state.currentContext)) return;
    if (regenerate && state.activeChat?.draft) { window.VocabAtelier?.toast("当前还没有可以重新生成的回复"); return; }
    if (state.activeChat?.draft && !await persistChatDraft()) return;
    if (!regenerate) { state.messages.push({ role: "user", content, status: "complete", actions: [] }); input.value = ""; }
    const searchAll = !regenerate && Boolean($("#search-all-notes-once")?.checked);
    if (!regenerate && $("#search-all-notes-once")) $("#search-all-notes-once").checked = false;
    const assistant = { role: "assistant", content: "", status: "generating", actions: [], citations: [] }; state.messages.push(assistant); renderMessages(); setStreaming(true);
    try {
      const selection = currentChatSelection();
      const requestPayload = regenerate ? {regenerate:true} : {content, search_all_notes:searchAll};
      requestPayload.selection_mode = selection.mode;
      requestPayload.requested_model = selection.model;
      const response = await fetch(`${API}/api/chats/${state.activeChat.id}/messages`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(requestPayload) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || "发送失败"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const {value, done} = await reader.read(); if (done) break; buffer += decoder.decode(value, {stream:true});
        const blocks = buffer.split("\n\n"); buffer = blocks.pop() || "";
        for (const block of blocks) {
          const eventName = block.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
          const raw = block.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim(); if (!raw) continue;
          const data = JSON.parse(raw);
          if (eventName === "start") { assistant.id = data.message_id || assistant.id; assistant.routing = data.routing || {}; assistant.model = data.model || ""; scheduleMessagesRender(); }
          if (eventName === "route") { assistant.routing = data.routing || assistant.routing || {}; assistant.model = data.model || assistant.model || ""; scheduleMessagesRender(); }
          if (eventName === "delta") { assistant.content += data.text || ""; scheduleMessagesRender(); }
          if (eventName === "replace") { assistant.content = data.text || ""; scheduleMessagesRender(); }
          if (eventName === "sources") { assistant.citations = data.sources || []; scheduleMessagesRender(); }
          if (eventName === "actions") { assistant.actions = data.actions || []; scheduleMessagesRender(); }
          if (eventName === "done") {
            assistant.status = data.status || "complete";
            assistant.routing = data.routing || assistant.routing || {};
            assistant.model = data.model || assistant.model || "";
            rememberRoute(data.message_id || assistant.id, assistant.routing);
            if (!assistant.content.trim()) throw new Error("模型没有返回可显示内容，请重试。");
          }
          if (eventName === "error") throw new Error(data.message || "生成中断");
        }
      }
      if (!assistant.content.trim()) throw new Error("模型没有返回可显示内容，请重试。");
      cacheActiveChat();
      const completedRouting = assistant.routing ? {...assistant.routing} : null;
      const completedChatId = state.activeChat?.id;
      await refreshChats(completedChatId, { force: true });
      // Routing metadata is intentionally UI-only (the message schema stays
      // unchanged).  Reattach it after the forced refresh so the just-finished
      // answer does not lose its free/fallback badge during list revalidation.
      if (completedRouting && completedChatId && state.activeChat?.id === completedChatId) {
        const latest = [...state.messages].reverse().find(message => message.role === "assistant");
        if (latest) latest.routing = completedRouting;
        renderMessages();
      }
    } catch (error) { assistant.status = "error"; assistant.content ||= error.message; renderMessages(); }
    finally { cacheActiveChat(); setStreaming(false); }
  }

  function setStreaming(value) { state.streaming = value; $("#stop-chat").classList.toggle("hidden", !value); $("#send-chat").classList.toggle("hidden", value); $("#chat-input").disabled = value; $("#chat-model-select").disabled = value; }

  async function stopChat() {
    if (!state.activeChat) return;
    try { await api(`/api/chats/${state.activeChat.id}/stop`, { method: "POST", body: "{}" }); }
    catch { /* stream reader will surface connection state */ }
  }

  async function renameChat() {
    if (!state.activeChat) return; const title = prompt("新的会话名称", state.activeChat.title); if (!title?.trim()) return;
    try { const data = await api(`/api/chats/${state.activeChat.id}`, { method: "PATCH", body: JSON.stringify({title:title.trim()}) }); state.activeChat = data.chat; await refreshChats(data.chat.id); }
    catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  async function deleteChat() {
    if (!state.activeChat || !confirm(`确定永久删除“${state.activeChat.title}”吗？`)) return;
    const deletedId = state.activeChat.id;
    try {
      await api(`/api/chats/${deletedId}`, { method: "DELETE" });
      state.chatCache.delete(deletedId); state.chatLoads.delete(deletedId); state.chatHtmlCache.delete(deletedId);
      state.chats = state.chats.filter(chat => chat.id !== deletedId);
      state.activeChat = null; state.chatsRefreshedAt = Date.now();
      renderChatList();
      if (state.chats[0]) await selectChat(state.chats[0].id); else clearChatView();
    }
    catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  async function clearContext() {
    if (!state.activeChat) return;
    if (state.activeChat.draft) { state.activeChat.current_context = null; state.currentContext = null; updateChatHead(); return; }
    try { const data = await api(`/api/chats/${state.activeChat.id}`, { method: "PATCH", body: JSON.stringify({current_context:null}) }); state.activeChat = data.chat; state.currentContext = null; updateChatHead(); await refreshChats(data.chat.id); }
    catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  async function confirmAction(messageIndex, actionIndex, card) {
    const action = state.messages[messageIndex]?.actions?.[actionIndex]; if (!action) return;
    try {
      let word = state.personalWords.find(item => norm(item.word) === norm(action.word));
      if (!word) word = await classifyAndSave({word:action.word, definition:"来自 AI 助教推荐", source:"chat"}, false);
      if (action.type === "save_word") { window.VocabAtelier?.setSaved(word.word, true); await api(`/api/words/${word.id}`, {method:"PATCH",body:JSON.stringify({saved:true})}); }
      if (action.type === "review_word") { window.VocabAtelier?.setStatus(word.word, "review"); await api(`/api/words/${word.id}`, {method:"PATCH",body:JSON.stringify({status:"review"})}); }
      if (action.type === "edit_category") { const data = await api(`/api/words/${word.id}`, {method:"PATCH",body:JSON.stringify({topic:action.category})}); word = data.word; await refreshWords(); }
      card.classList.add("done"); const button = card.querySelector("button"); button.disabled = true; button.textContent = "已执行"; window.VocabAtelier?.toast("学习操作已确认");
    } catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  function openWordEditor(word) {
    if (!word?.id) return;
    $("#word-edit-id").value = word.id; $("#word-edit-name").value = word.word; $("#word-edit-definition").value = word.definition || "";
    $("#word-edit-band").value = word.band || "6.5"; $("#word-edit-pos").value = word.pos || ""; $("#word-edit-topic").value = word.topic || "General Vocabulary";
    $("#word-edit-related-topics").value = (word.related_topics || []).join(", "); $("#word-edit-learning-mode").value = word.learning_mode || "auto";
    $("#word-edit-status").value = word.status || "learning"; $("#word-edit-tags").value = (word.tags || []).join(", "); $("#word-edit-note").value = word.note || ""; openDrawer();
  }

  async function saveWordEdit(event) {
    event.preventDefault(); const id = $("#word-edit-id").value;
    const payload = { definition: $("#word-edit-definition").value.trim(), band: $("#word-edit-band").value.trim(), pos: $("#word-edit-pos").value.trim(), topic: $("#word-edit-topic").value, related_topics: $("#word-edit-related-topics").value.split(",").map(item=>item.trim()).filter(item=>TOPICS.includes(item)), learning_mode: $("#word-edit-learning-mode").value, status: $("#word-edit-status").value, tags: $("#word-edit-tags").value.split(",").map(item=>item.trim()).filter(Boolean), note: $("#word-edit-note").value.trim(), source: "personal-edit", _manual: true };
    try { const data = await api(`/api/words/${id}`, {method:"PATCH",body:JSON.stringify(payload)}); await refreshWords(); window.VocabAtelier?.setStatus(data.word.word, data.word.status); closeDrawer(); window.VocabAtelier?.lookup(data.word.word); window.VocabAtelier?.toast("词条已更新"); }
    catch (error) { window.VocabAtelier?.toast(error.message); }
  }

  async function askAboutCurrentWord() {
    const item = window.VocabAtelier?.getCurrentWord(); if (!item) return;
    const context = {word:item.word, definition:item.definition, pos:item.pos, band:item.band, topic:item.topic};
    const chat = createChat(context); if (chat) { window.VocabAtelier.switchTab("assistant"); $("#chat-input").focus(); }
  }

  function setChatSidebarCollapsed(collapsed, persist = true) {
    const enabled = Boolean(collapsed && chatSidebarMedia.matches);
    const shell = $(".assistant-shell");
    const toggle = $("#chat-history-toggle");
    shell?.classList.toggle("history-collapsed", enabled);
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(!enabled));
      toggle.setAttribute("aria-label", enabled ? "展开对话历史" : "收起对话历史");
      toggle.title = enabled ? "展开对话历史" : "收起对话历史";
      const icon = toggle.querySelector("span");
      if (icon) icon.textContent = enabled ? "›" : "‹";
    }
    if (persist) localStorage.setItem("ielts_chat_history_collapsed", String(Boolean(collapsed)));
  }

  function bind() {
    $("#open-api-settings").addEventListener("click", () => { showFormStatus(""); openModal(); });
    $("#api-form").addEventListener("submit", saveConfig); $("#test-api-config").addEventListener("click", testConfig); $("#clear-api-config").addEventListener("click", clearConfig);
    $("#api-default-model").addEventListener("change", event => { const selection = parseModelSelection(event.target.value); $("#default-model-status").textContent = selection.mode === "deepseek" ? "所有 AI 任务默认使用 DeepSeek" : selection.mode === "fixed_free" ? `所有 AI 任务优先使用 ${selection.model}` : "自动按任务选择免费模型，必要时使用 DeepSeek 兜底"; });
    $("#chat-list").addEventListener("click", event => { const item = event.target.closest("[data-chat-id]"); if (item) selectChat(item.dataset.chatId); });
    $("#chat-history-toggle").addEventListener("click", () => setChatSidebarCollapsed(!$(".assistant-shell").classList.contains("history-collapsed")));
    chatSidebarMedia.addEventListener?.("change", () => setChatSidebarCollapsed(chatSidebarPreference(), false));
    $("#new-chat").addEventListener("click", () => createChat()); $("#mobile-new-chat").addEventListener("click", () => createChat()); $("#mobile-chat-select").addEventListener("change", event => { if (event.target.value) selectChat(event.target.value); }); $("#rename-chat").addEventListener("click", renameChat); $("#delete-chat").addEventListener("click", deleteChat);
    $("#chat-form").addEventListener("submit", sendChat); $("#stop-chat").addEventListener("click", stopChat); $("#regenerate-chat").addEventListener("click", () => sendChat(null, true));
    $("#chat-model-select").addEventListener("change", event => { saveChatSelection(parseModelSelection(event.target.value)); renderModelSelectors(); });
    $("#chat-input").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(event); } });
    $("#chat-context-chip").addEventListener("click", event => { if (event.target.closest("[data-clear-context]")) clearContext(); });
    $("#choose-chat-notes").addEventListener("click", chooseChatNotes);
    $("#chat-note-chips").addEventListener("click", async event => { const button = event.target.closest("[data-remove-chat-note]"); if (!button) return; state.linkedNotes = state.linkedNotes.filter(note => note.id !== button.dataset.removeChatNote); renderChatNotes(); try { await persistChatNotes(); } catch (error) { window.VocabAtelier?.toast(error.message); } });
    $("#chat-messages").addEventListener("click", event => {
      const copy = event.target.closest("[data-copy-message]"); if (copy) navigator.clipboard.writeText(state.messages[Number(copy.dataset.index)]?.content || "").then(() => window.VocabAtelier?.toast("已复制"));
      const saveNote = event.target.closest("[data-save-message-note]"); if (saveNote) window.VocabNotes?.saveAssistantMessage?.(state.messages[Number(saveNote.dataset.index)]?.content || "");
      const citation = event.target.closest("[data-open-note]"); if (citation) window.VocabNotes?.openNote?.(citation.dataset.openNote);
      const confirm = event.target.closest("[data-confirm-action]"); if (confirm) confirmAction(Number(confirm.dataset.messageIndex), Number(confirm.dataset.actionIndex), confirm.closest("[data-action-card]"));
    });
    $("#word-edit-topic").innerHTML = TOPICS.map(topic => `<option value="${attr(topic)}">${esc(topic)}</option>`).join("");
    $("#word-edit-form").addEventListener("submit", saveWordEdit); document.querySelectorAll("[data-close-drawer]").forEach(button => button.addEventListener("click", closeDrawer));
    $("#word-drawer").addEventListener("click", event => { if (event.target === $("#word-drawer")) closeDrawer(); });
    $("#word-detail").addEventListener("click", event => {
      if (event.target.closest("[data-ai-analyze]")) analyzeCurrentWord();
      if (event.target.closest("[data-ask-assistant]")) askAboutCurrentWord();
      if (event.target.closest("[data-edit-personal]")) { const current = window.VocabAtelier?.getCurrentWord(); openWordEditor(state.personalWords.find(word => word.id === current?.id || norm(word.word) === norm(current?.word))); }
    });
    window.addEventListener("vocab:current-word", event => { state.currentContext = event.detail.item; });
    window.addEventListener("vocab:status", async event => { try { const word = await classifyAndSave(event.detail.item, false, false); const data = await api(`/api/words/${word.id}`, {method:"PATCH",body:JSON.stringify({status:event.detail.status})}); state.personalWords = [data.word, ...state.personalWords.filter(item => item.id !== data.word.id)]; } catch {} });
    window.addEventListener("vocab:saved", async event => { try { const word = await classifyAndSave(event.detail.item, false, false); const data = await api(`/api/words/${word.id}`, {method:"PATCH",body:JSON.stringify({saved:event.detail.saved})}); state.personalWords = [data.word, ...state.personalWords.filter(item => item.id !== data.word.id)]; } catch {} });
    window.addEventListener("hashchange", () => { if (location.hash === "#assistant") refreshChats(); });
  }

  window.VocabAtelierAI = {
    enrichRemoteWord(item) { return classifyAndSave(item, false, true); },
    startNoteChat(note) {
      if (!note?.id) return;
      createChat();
      state.activeChat.title = `${note.title} · 笔记问答`;
      state.linkedNotes = [{id:note.id, title:note.title}];
      renderChatList(); updateChatHead(); renderChatNotes();
      window.VocabAtelier?.switchTab("assistant");
      $("#chat-input").placeholder = `围绕“${note.title}”提问…`;
      $("#chat-input").focus();
    }
  };

  async function init() {
    bind(); setChatSidebarCollapsed(chatSidebarPreference(), false); await refreshConfig(); await migrateLegacy(); await refreshWords(); await refreshChats();
  }
  init();
})();
