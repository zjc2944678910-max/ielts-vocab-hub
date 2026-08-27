(() => {
  "use strict";

  const rawDatabase = Array.isArray(window.ieltsCatalog) ? window.ieltsCatalog : Array.isArray(window.ieltsFullDatabase) ? window.ieltsFullDatabase :
    (typeof ieltsFullDatabase !== "undefined" ? ieltsFullDatabase : []);
  const rawMixedData = Array.isArray(window.ieltsCatalog)
    ? (typeof paraphrasePairsFull !== "undefined" && Array.isArray(paraphrasePairsFull) ? paraphrasePairsFull.filter(item => item?.low) : [])
    : (typeof paraphrasePairsFull !== "undefined" && Array.isArray(paraphrasePairsFull) ? paraphrasePairsFull : []);
  // Older data builds accidentally appended vocabulary records to the quiz array.
  // Recover those records at load time while keeping dict.js backward-compatible.
  const recoveredVocabulary = new Map();
  [...rawDatabase, ...rawMixedData.filter(item => item?.word)].forEach(item => {
    const key = item.word.toLowerCase();
    if (!recoveredVocabulary.has(key)) recoveredVocabulary.set(key, item);
  });
  const curated = [...recoveredVocabulary.values()].map(item => ({
    ...item,
    related_topics: item.related_topics || [],
    classification_source: "curated",
    manual_fields: item.manual_fields || [],
    catalogs: item.catalogs || ["ielts"]
  }));
  const legacyQuiz = rawMixedData.filter(item => item && item.low && Array.isArray(item.options));
  const store = {
    saved: read("ielts_saved_words", ["alleviate", "ubiquitous", "mitigate"]),
    mastered: read("ielts_mastered", []),
    review: read("ielts_review", []),
    discovered: read("ielts_discovered", []),
    activity: read("ielts_activity_v2", { date: today(), lookups: 0, studied: [], streak: 1, lastDate: today() })
  };
  if (store.activity.date !== today()) store.activity = { ...store.activity, date: today(), lookups: 0, studied: [] };

  let quizIndex = 0;
  let quizStreak = 0;
  let proxyOnline = ["localhost", "127.0.0.1"].includes(location.hostname);
  let lookupSequence = 0;
  let lookupController = null;
  let suggestionController = null;
  let suggestionTimer = null;
  let suggestionSequence = 0;
  let searchComposing = false;
  const lookupCache = new Map();
  let toastTimer;
  let currentWord = null;
  const sidebarMedia = window.matchMedia("(min-width: 721px)");
  const sidebarPreference = () => localStorage.getItem("ielts_sidebar_collapsed") === "true";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const dataset = () => {
    const personal = new Map(store.discovered.map(item => [norm(item.word), item]));
    const merged = curated.map(item => {
      const override = personal.get(norm(item.word));
      if (!override) return item;
      const manual = new Set(override.manual_fields || []);
      const result = { ...item, id: override.id, saved: override.saved, status: override.status, note: override.note || item.note, tags: [...new Set([...(item.tags || []), ...(override.tags || [])])], manual_fields: [...manual] };
      ["definition", "band", "pos", "module", "topic", "related_topics", "learning_mode"].forEach(field => { if (manual.has(field)) result[field] = override[field]; });
      return result;
    });
    const existing = new Set(merged.map(item => norm(item.word)));
    return [...merged, ...store.discovered.filter(item => !existing.has(norm(item.word)))];
  };
  const quizItems = () => {
    const generated = curated.filter(item => item.study_eligible !== false && item.synonyms?.length).map(item => ({
      low: `${item.definition}（${item.pos || "词汇"}）`, target: item.word,
      options: shuffle([item.word, ...curated.filter(x => x.word !== item.word).map(x => x.word)]).slice(0, 4),
      explanation: `${item.word}：${item.paraphraseExamContext || item.definition}`
    })).map(item => ({ ...item, options: item.options.includes(item.target) ? shuffle(item.options) : shuffle([item.target, ...item.options.slice(0, 3)]) }));
    return [...legacyQuiz.map(item => ({ ...item, target: item.options[item.correct] })), ...generated];
  };

  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function looseQuery(value) { return String(value || "").trim().replace(/\s+/g, " "); }
  function norm(value) { return looseQuery(value).toLowerCase().replace(/(\w)-(\w)/g, "$1 $2"); }
  function hasChinese(value) { return /[\u3400-\u9fff]/.test(String(value || "")); }
  function isTimeoutError(error) { return error?.name === "TimeoutError" || /timed out|timeout/i.test(String(error?.message || "")); }
  function shouldAutoTranslate(query) {
    const value = looseQuery(query);
    return hasChinese(value) || /[\s-]/.test(value);
  }
  function dictionaryTimeout(source) {
    if (source === "ai") return 40000;
    if (source === "smart") return 20000;
    return 8000;
  }
  function compactChinese(value) { return String(value || "").replace(/[\s·・．.]+/g, ""); }
  function chineseTokens(query) {
    const chars = compactChinese(query).replace(/[^\u3400-\u9fff]/g, "");
    const tokens = [];
    if (chars.length >= 2) tokens.push(chars);
    if (chars.length >= 4) {
      tokens.push(chars.slice(0, 2), chars.slice(2));
      if (chars.length >= 6) tokens.push(chars.slice(0, 3), chars.slice(3));
    }
    return [...new Set(tokens.filter(token => token.length >= 2))];
  }
  function needsChineseRefresh(item) {
    const source = item?.source || item?._source;
    return (source === "dictionary" && !hasChinese(item?.definition)) || (source === "cambridge" && !item?.auto_classified);
  }
  function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char])); }
  function attr(value) { return esc(value).replace(/`/g, "&#96;"); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function shuffle(items) { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function band(item) { return parseFloat(item.band) || 0; }
  function levenshtein(a, b) { const row = Array.from({length: b.length + 1}, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; } } return row[b.length]; }
  function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800); }

  function setSidebarCollapsed(collapsed, persist = true) {
    const enabled = Boolean(collapsed && sidebarMedia.matches);
    document.body.classList.toggle("sidebar-collapsed", enabled);
    const toggle = $("#sidebar-toggle");
    toggle.setAttribute("aria-expanded", String(!enabled));
    toggle.setAttribute("aria-label", enabled ? "展开侧边栏" : "收起侧边栏");
    toggle.title = enabled ? "展开侧边栏" : "收起侧边栏";
    if (persist) localStorage.setItem("ielts_sidebar_collapsed", String(Boolean(collapsed)));
  }

  function switchTab(tab, updateHash = true) {
    const requested = tab;
    const mapped = {flashcards:"study", dictation:"study", paraphrase:"study"}[tab] || tab;
    const target = $(`#view-${mapped}`) ? mapped : "lookup";
    $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${target}`));
    $$("[data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === target));
    document.body.classList.toggle("assistant-mode", target === "assistant");
    document.body.classList.toggle("notes-mode", target === "notes");
    document.body.classList.remove("menu-open");
    if (updateHash) history.replaceState(null, "", `#${target === "study" && (requested === "paraphrase" || requested === "dictation") ? requested : target}`);
    if (target === "library") {
      if (window.VocabStudy?.renderLibrary) window.VocabStudy.renderLibrary();
      else renderLibrary();
    }
    if (target === "study") {
      window.VocabStudy?.renderStudy?.();
      if (requested === "paraphrase") window.VocabStudy?.openParaphrase?.();
      if (requested === "dictation") window.VocabStudy?.openDictation?.();
    }
    if (target === "speaking") window.VocabSpeaking?.activate?.();
    else window.VocabSpeaking?.pause?.();
    if (target === "settings") window.VocabStudy?.renderSettings?.();
    if (target === "notebook") renderNotebook();
    if (target === "notes") window.VocabNotes?.activate?.();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function updateStats() {
    $("#saved-count").textContent = store.saved.length;
    $("#stat-lookups").textContent = store.activity.lookups || 0;
    $("#stat-mastered").textContent = store.mastered.length;
    $("#stat-review").textContent = store.review.length;
    $("#streak-days").textContent = `${store.activity.streak || 1} 天`;
    const score = Math.min(100, Math.round(((store.activity.studied?.length || 0) / 10) * 100));
    $("#daily-progress").textContent = `${score}%`;
    $("#daily-ring").style.setProperty("--p", `${score}%`);
    $("#daily-copy").textContent = score ? `${store.activity.studied.length} / 10 个学习目标` : "开始第一个单词";
    save("ielts_activity_v2", store.activity);
  }

  function markActivity(word, isLookup = false) {
    if (isLookup) store.activity.lookups = (store.activity.lookups || 0) + 1;
    store.activity.studied ||= [];
    if (word && !store.activity.studied.includes(norm(word))) store.activity.studied.push(norm(word));
    updateStats();
  }

  function matchesFor(query, limit = 7) {
    const q = norm(query);
    if (!q) return [];
    const chinese = hasChinese(q);
    const tokens = chinese ? chineseTokens(q) : [];
    const pieces = tokens.slice(1);
    return dataset().map(item => {
      const word = norm(item.word);
      const definition = String(item.definition || "");
      const collocations = (item.collocations || []).join(" ");
      const blob = `${definition}\n${collocations}`;
      let score = 1000;
      if (chinese) {
        if (tokens[0] && blob.includes(tokens[0])) score = 8;
        if (pieces.length && pieces.every(token => blob.includes(token))) score = Math.min(score, 4);
        else if (pieces.some(token => blob.includes(token))) score = Math.min(score, 16);
      } else {
        score = word === q ? 0 : word.startsWith(q) ? 10 : word.includes(q) ? 20 : norm(collocations).includes(q) ? 18 : 100 + levenshtein(word, q);
      }
      if (store.saved.includes(item.word)) score -= 5;
      else if (item.classification_source === "curated") score -= 2;
      return { item, score };
    }).filter(x => chinese ? x.score <= 20 : (x.score <= 22 || levenshtein(norm(x.item.word), q) <= 2)).sort((a, b) => a.score - b.score || a.item.word.localeCompare(b.item.word)).slice(0, limit).map(x => x.item);
  }

  function renderSuggestionItems(query, items) {
    const box = $("#suggestions");
    if (!query) return box.classList.remove("open");
    const phraseQuery = hasChinese(query) || query.includes(" ");
    const searchRow = `<button type="button" class="suggestion suggestion-query" data-word="${attr(query)}"><b>查询 “${esc(query)}”</b><span>${hasChinese(query) ? "本地词库 / Google 中译英" : "本地词库 / Google 英译中"}</span></button>`;
    const rows = items.map(item => `<button type="button" class="suggestion" data-word="${attr(item.word)}"><b>${esc(item.word)}</b><span>${esc(item.definition)}</span></button>`).join("");
    box.innerHTML = phraseQuery ? `${searchRow}${rows}` : (rows || searchRow);
    box.classList.add("open");
  }

  function scheduleSuggestions(query, delay = 100) {
    clearTimeout(suggestionTimer);
    suggestionController?.abort();
    const clean = norm(query);
    if (!clean || searchComposing) return $("#suggestions").classList.remove("open");
    const localItems = matchesFor(clean);
    renderSuggestionItems(clean, localItems);
    const requestId = ++suggestionSequence;
    suggestionTimer = setTimeout(async () => {
      if (!proxyOnline || searchComposing) return;
      suggestionController = new AbortController();
      try {
        const apiBase = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
        const signal = AbortSignal.any([suggestionController.signal, AbortSignal.timeout(2500)]);
        const response = await fetch(`${apiBase}/api/dictionary/suggest?q=${encodeURIComponent(clean)}&limit=8`, {signal});
        if (!response.ok || requestId !== suggestionSequence || searchComposing) return;
        const remote = (await response.json()).suggestions || [];
        const merged = new Map([...localItems, ...remote].map(item => [norm(item.word), item]));
        renderSuggestionItems(clean, [...merged.values()].slice(0, 8));
      } catch (error) {
        if (error?.name !== "AbortError" && error?.name !== "TimeoutError") console.debug("dictionary suggestions unavailable");
      }
    }, delay);
  }


  function freeDictionaryItem(entries, query) {
    const entry = (entries || []).find(item => norm(item.word) === query);
    if (!entry) return null;
    const senses = [], synonyms = [];
    (entry.meanings || []).forEach(meaning => (meaning.definitions || []).slice(0, Math.max(0, 16 - senses.length)).forEach(definition => {
      if (!definition.definition) return;
      senses.push({ id:`free-${senses.length + 1}`, headword:entry.word, pos:meaning.partOfSpeech || "", definition:definition.definition, definition_en:definition.definition, examples:definition.example ? [{en:definition.example,cn:""}] : [], source:"free" });
      synonyms.push(...(definition.synonyms || []), ...(meaning.synonyms || []));
    }));
    if (!senses.length) return null;
    return normalizeRemote({ word:entry.word, query, headword:entry.word, exact:true, phonetic:entry.phonetic || entry.phonetics?.find(item => item.text)?.text, pos:senses[0].pos, definition:senses[0].definition, senses, synonyms }, "free");
  }

  function renderSourceCoverage(sources = []) {
    if (!sources.length) return "";
    const label = {oxford:"Oxford 英汉",ecdict:"ECDICT",google:"Google 翻译",local:"本地词库"};
    return `<div class="source-coverage">${sources.map(item => `<span class="${item.status === "ok" ? "available" : ""}"><i></i>${esc(label[item.id] || item.id)}${item.status === "ok" ? ` · ${Number(item.sense_count) || 0} 义` : item.status === "no_chinese" ? " · 无中文释义" : item.status === "unavailable" ? " · 暂不可用" : " · 无精确词条"}</span>`).join("")}</div>`;
  }

  function isDictionaryMatch(item) { return Boolean(item?.exact || item?.match_kind === "inflection" || item?.match_kind === "phrase"); }

  function hasChineseDictionaryDefinition(item) {
    const definitions = [item?.definition, ...(item?.senses || []).map(sense => sense?.definition)];
    return definitions.some(definition => hasChinese(String(definition || "")));
  }

  function showAlternative(query, item, sources = []) {
    $("#word-detail").innerHTML = `${renderSourceCoverage(sources)}<div class="dictionary-notice"><p class="eyebrow">未找到精确词条</p><h2>“${esc(query)}” 不是 “${esc(item.headword || item.word)}”</h2><p>本地词库把查询指到了另一个词，没有自动替换。</p><div><button class="secondary" data-word="${attr(item.headword || item.word)}">查看 ${esc(item.headword || item.word)}</button></div></div>`;
  }

  function renderTranslationResult(item, source) {
    currentWord = null;
    const expressions = Array.isArray(item.expressions) ? item.expressions : [];
    const isAi = item.source === "ai";
    const direction = item.direction === "zh-en" ? "中译英" : "英译中";
    const rows = expressions.map((entry, index) => {
      const examples = (entry.examples || []).slice(0, 2);
      const english = entry.expression || "";
      const translation = entry.translation_cn || (item.direction === "en-zh" ? entry.definition_en : "");
      const explanation = item.direction === "zh-en" ? entry.definition_en : "";
      return `<article class="translation-item"><div class="sense-index">${String(index + 1).padStart(2,"0")}</div><div><header><button class="translation-expression" data-lookup-word="${attr(english)}">${esc(english)}</button><button class="mini-audio" data-speak="${attr(english)}" aria-label="播放 ${attr(english)} 发音"><img src="assets/graphic-eq-round.svg" alt="" aria-hidden="true"></button>${entry.pos ? `<span>${esc(entry.pos)}</span>` : ""}</header>${translation ? `<p>${esc(translation)}</p>` : ""}${explanation ? `<small>${esc(explanation)}</small>` : ""}${examples.map(example => `<div class="sense-example">${esc(example.en)}${example.cn ? `<small>${esc(example.cn)}</small>` : ""}</div>`).join("")}</div></article>`;
    }).join("");
    const engine = item.source === "google" ? "Google 翻译" : item.source === "local" ? "本地词库" : isAi ? "AI 翻译" : "词典结果";
    const sourceLink = isAi ? "AI 生成内容，请结合语境核对" : item.source === "google" ? `<a href="${attr(item.source_url || "https://translate.google.com/?hl=zh-CN")}" target="_blank" rel="noopener noreferrer">Google 翻译 ↗</a>` : "本地词库";
    const route = item.ai_meta || item.routing || {};
    const routeLabel = route.source === "free_model" ? `免费模型 · ${route.actual_model || route.model || "OpenRouter"}` : route.source === "fallback_model" ? `备用模型 · ${route.actual_model || route.model || "已配置模型"}` : "";
    const routeNotice = isAi && routeLabel ? `<span class="ai-route-notice">${esc(routeLabel)}</span>` : "";
    $("#word-detail").innerHTML = `<section class="translation-result"><header><div><p class="eyebrow">${esc(direction)} · ${esc(engine.toUpperCase())}</p><h2>${esc(item.query)}</h2></div><span class="source-badge ${isAi ? "ai" : ""}">${esc(engine)}</span></header><p class="translation-guidance">${isAi ? "以下表达由 AI 根据语境生成，不会自动加入生词本。点击英文可继续查词。" : "下面是对应表达，点击英文可继续查词。"}</p>${routeNotice}<div class="translation-list">${rows}</div><div class="source-line">来源：${sourceLink}</div></section>`;
  }

  function friendlyLookupError(message) {
    const text = String(message || "");
    if (/\$\.|未通过本地校验|expressions|invalid_ai_json/.test(text)) return "翻译没有返回可用结果，请再试一次。";
    return text;
  }

  function renderNotFound(query, source, local, message = "") {
    if (local && source === "smart") { renderWord(local, local._discovered ? "个人词库" : "精选雅思词库"); return; }
    const near = matchesFor(query, 1)[0];
    const suggestion = near && norm(near.word) !== query && levenshtein(norm(near.word), query) <= 2 ? `<button class="secondary" data-word="${attr(near.word)}">是否要查 ${esc(near.word)}？</button>` : "";
    const configAction = /API|配置/.test(friendlyLookupError(message)) ? `<button class="secondary" data-open-api-settings>前往 API 设置</button>` : "";
    $("#word-detail").innerHTML = `<div class="dictionary-notice"><p class="eyebrow">NO RESULT</p><h2>没有找到 “${esc(query)}”</h2><p>${esc(friendlyLookupError(message) || "本地词库和 Google 翻译都没有可用结果。")}</p><div>${suggestion}${configAction}</div></div>`;
  }

  async function requestDictionary(query, source, signal) {
    const cacheKey = `${source}:${query}`;
    const cached = lookupCache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.data;
    const apiBase = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
    const timeout = dictionaryTimeout(source);
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const response = await fetch(`${apiBase}/api/dictionary/lookup?word=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`, {signal: combinedSignal});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(data?.error?.message || "词典暂时不可用");
      failure.status = response.status;
      throw failure;
    }
    if (source !== "ai") lookupCache.set(cacheKey, {data, savedAt: Date.now()});
    return data;
  }

  function mergeDictionaryResults(items, statuses) {
    const available = items.filter(Boolean);
    const preferred = available.find(item => (item.source || item._source) === "cambridge") || available[0];
    const metadata = available.find(item => item.classification_source === "curated") || available.find(item => (item.source || item._source) === "ecdict") || preferred;
    const senses = [], seen = new Set();
    available.forEach(item => (item.senses?.length ? item.senses : [{pos:item.pos, definition:item.definition, examples:item.examples || [], source:item.source || item._source}]).forEach(sense => {
      const key = `${norm(sense.pos || "")}:${norm(sense.definition || sense.definition_en || "")}`;
      if (!key.endsWith(":") && !seen.has(key)) { seen.add(key); senses.push(sense); }
    }));
    return {
      ...metadata, ...preferred,
      band: metadata.band || preferred.band,
      topic: metadata.topic || preferred.topic,
      module: metadata.module || preferred.module,
      related_topics: metadata.related_topics || preferred.related_topics || [],
      classification_source: metadata.classification_source || preferred.classification_source,
      senses: senses.slice(0, 16),
      examples: senses.flatMap(sense => sense.examples || []).slice(0, 8),
      source: "smart", _source: "smart", source_statuses: statuses,
    };
  }

  async function lookupWithAi(query, local, requestId, signal) {
    const isCurrent = () => requestId === lookupSequence && !signal.aborted;
    $("#word-detail").innerHTML = `<div class="loading-line">词典没有现成词条，正在用 AI 翻译 “${esc(query)}”…</div>`;
    try {
      const data = await requestDictionary(query, "ai", signal);
      if (!isCurrent()) return true;
      if (Array.isArray(data?.result?.expressions)) {
        renderTranslationResult(data.result, "ai");
        markActivity(query, true);
        return true;
      }
    } catch (error) {
      if (error?.name === "AbortError" && !isTimeoutError(error)) return true;
      if (isCurrent()) renderNotFound(query, "smart", local, error.message);
      return true;
    }
    return false;
  }

  async function lookupSmartEnglish(query, local, requestId, signal) {
    const isCurrent = () => requestId === lookupSequence && !signal.aborted;
    try {
      const data = await requestDictionary(query, "smart", signal);
      if (!isCurrent()) return;
      if (Array.isArray(data?.result?.expressions)) {
        renderTranslationResult(data.result, data.mode || "ai");
        markActivity(query, true);
        return;
      }
      const remote = data?.result && normalizeRemote({...data.result, source_statuses:data.sources || []}, data.result.source || "smart");
      if (remote && !isDictionaryMatch(remote)) {
        if (shouldAutoTranslate(query) && await lookupWithAi(query, local, requestId, signal)) return;
        showAlternative(query, remote, data.sources || []);
        return;
      }
      if (remote && hasChineseDictionaryDefinition(remote)) {
        const merged = local ? mergeDictionaryResults([remote, local], data.sources || []) : remote;
        rememberDiscovered(merged);
        renderWord(merged, remote._source === "google" ? "Google 翻译" : "本地词库");
        markActivity(merged.word, true);
        return;
      }
    } catch (error) {
      if (error?.name === "AbortError" && !isTimeoutError(error)) return;
      if (isCurrent() && shouldAutoTranslate(query) && await lookupWithAi(query, local, requestId, signal)) return;
      if (isCurrent()) renderNotFound(query, "smart", local, error.message);
      return;
    }
    if (isCurrent() && shouldAutoTranslate(query) && await lookupWithAi(query, local, requestId, signal)) return;
    if (isCurrent()) renderNotFound(query, "smart", local, "没有找到可用的中文释义。");
  }

  async function lookup(word, options = {}) {
    const typed = looseQuery(word);
    const query = norm(typed);
    if (!query) return;
    lookupController?.abort();
    lookupController = new AbortController();
    const requestId = ++lookupSequence;
    $("#search-input").value = word;
    $("#suggestions").classList.remove("open");
    switchTab("lookup");
    const local = dataset().find(item => norm(item.word) === query);
    const localChinese = local && hasChineseDictionaryDefinition(local) ? local : null;
    if (localChinese && !hasChinese(typed)) renderWord(localChinese, localChinese._discovered ? "个人词库 · 在线词典补充中" : "精选雅思词库 · 在线词典补充中");
    else $("#word-detail").innerHTML = `<div class="loading-line">正在查询 “${esc(typed)}”…</div>`;
    if (proxyOnline) {
      await lookupSmartEnglish(typed, localChinese, requestId, lookupController.signal);
      return;
    }
    if (localChinese) return;
    renderNotFound(typed, "smart", localChinese, "本地代理未连接，只能使用已缓存的词条。");
  }

  function normalizeRemote(data, source) {
    return { ...data, word: data.word, query: data.query || data.word, headword: data.headword || data.word, exact: data.exact !== false, phonetic: data.phonetic || `/${data.word}/`, pos: data.pos || "", definition: data.definition || "暂无释义", senses: Array.isArray(data.senses) ? data.senses : [], band: data.band || (data.word.length > 9 ? "7.5+" : "6.5"), module: data.module || "General English", topic: data.topic || "General Vocabulary", synonyms: [...new Set(data.synonyms || [])].slice(0, 8), antonyms: data.antonyms || [], collocations: data.collocations || [], examples: data.examples?.length ? data.examples : [], paraphraseExamContext: data.paraphraseExamContext || data.note || "对照不同词典的词性、释义和例句，优先记忆与你语境相关的义项。", _source: source };
  }

  function rememberDiscovered(item) {
    const index = store.discovered.findIndex(existing => norm(existing.word) === norm(item.word));
    if (index >= 0) store.discovered[index] = { ...store.discovered[index], ...item, _discovered: true };
    else store.discovered.push({ ...item, _discovered: true });
    save("ielts_discovered", store.discovered);
  }

  function renderWord(item, source = "精选雅思词库") {
    currentWord = item;
    const saved = store.saved.includes(item.word);
    const status = store.mastered.includes(item.word) ? "已掌握" : store.review.includes(item.word) ? "待复习" : "学习中";
    const itemSource = item.source || item._source;
    const classificationLabel = { curated: "精选分类", ai: "AI 自动分类", local: "本地规则分类", manual: "手动分类" }[item.classification_source] || (item.auto_classified ? "自动分类" : "");
    const sourceLinks = {
      google: `<a href="${attr(item.source_url || `https://translate.google.com/?hl=zh-CN&sl=en&tl=zh-CN&op=translate&text=${encodeURIComponent(item.query || item.word)}`)}" target="_blank" rel="noopener noreferrer">Google 翻译 ↗</a>`,
      ecdict: "ECDICT 本地词库",
      oxford: "Oxford 本机英汉词典",
      local: "本地词库",
      smart: "本地词库"
    };
    const sourceLabel = sourceLinks[itemSource] || esc(source);
    const inflection = item.match_kind === "inflection" && item.inflection ? item.inflection : null;
    const inflectionNote = inflection ? `<p class="inflection-note">${esc(inflection.form || item.query || "输入词形")} 是 ${esc(inflection.headword || item.word)} 的${esc(inflection.label || "词形变化")}。</p>` : "";
    const englishOnlyNotice = "";
    const highlight = text => esc(text || "").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    const senseNames = {oxford:"Oxford 英汉",ecdict:"ECDICT",google:"Google 翻译",local:"本地词库",smart:"本地词库"};
    const senses = Array.isArray(item.senses) && item.senses.length ? item.senses : [];
    const senseHtml = senses.length ? `<section class="sense-section"><header><small>MEANINGS · 全部义项</small><span>${senses.length} 个义项</span></header><div class="sense-list">${senses.map((sense, index) => {
      const examples = (sense.examples || []).slice(0, 2);
      const englishDefinition = sense.definition_en && norm(sense.definition_en) !== norm(sense.definition) ? `<p class="sense-english">${esc(sense.definition_en)}</p>` : "";
      return `<article class="sense-item"><div class="sense-index">${String(index + 1).padStart(2,"0")}</div><div class="sense-copy"><div class="sense-meta"><b>${esc(sense.pos || item.pos || "词义")}</b><span>${esc(senseNames[sense.source] || sense.source || source)}</span>${sense.level ? `<span>${esc(sense.level)}</span>` : ""}</div><p class="sense-definition">${esc(sense.definition || sense.definition_en || "暂无释义")}</p>${englishDefinition}${examples.map(example => `<div class="sense-example">${highlight(example.en)}${example.cn ? `<small>${esc(example.cn)}</small>` : ""}</div>`).join("")}</div></article>`;
    }).join("")}</div></section>` : `<div class="definition"><b>${esc(item.pos || "词义")}</b><p>${esc(item.definition)}</p></div>`;
    const coverage = renderSourceCoverage(item.source_statuses || []);
    $("#word-detail").innerHTML = `
      ${coverage}
      ${englishOnlyNotice}
      <div class="word-head"><div><div class="word-title"><h2>${esc(item.word)}</h2><span>${esc(item.phonetic || "")}</span></div><div class="tag-row"><span class="tag">Band ${esc(item.band || "6.5")}</span><span class="tag">${esc(item.topic || "Vocabulary")}</span><span class="tag">${status}</span></div>${inflectionNote}</div><div class="word-actions"><button class="audio-button audio-button-compact" data-speak="${attr(item.word)}" aria-label="播放 ${attr(item.word)} 发音" title="播放发音"><img src="assets/graphic-eq-round.svg" alt="" aria-hidden="true"></button><button class="icon-button ${saved ? "saved" : ""}" data-save="${attr(item.word)}" aria-label="收藏">${saved ? "★" : "☆"}</button></div></div>
      ${senseHtml}
      <div class="detail-section"><small>SYNONYMS · 同义替换</small><div class="pills">${(item.synonyms || []).filter(Boolean).map(word => `<button class="pill" data-word="${attr(word)}">${esc(word)}</button>`).join("") || "<span class='study-note'>暂无同义词数据</span>"}</div></div>
      ${(item.collocations || []).length ? `<div class="detail-section"><small>COLLOCATIONS · 常用搭配</small><div class="study-note">${item.collocations.map(esc).join("　·　")}</div></div>` : ""}
      ${senses.length ? "" : `<div class="detail-section"><small>EXAMPLES · 例句</small>${(item.examples || []).map(ex => `<p class="example">${highlight(ex.en)}${ex.cn ? `<small>${esc(ex.cn)}</small>` : ""}</p>`).join("") || "<p class='study-note'>暂无例句</p>"}</div>`}
      <div class="detail-section"><small>STUDY NOTE · 使用提示</small><p class="study-note">${esc(item.paraphraseExamContext || "结合语境记忆，并在写作中注意搭配是否自然。")}</p></div>
      <div class="word-extra-actions" id="word-ai-actions"><button class="secondary" data-ai-analyze>✦ AI 深度解析</button><button class="secondary" data-ask-assistant>带入 AI 助教</button>${item.id ? `<button class="secondary" data-edit-personal>编辑个人词条</button>` : ""}</div>
      <div id="word-ai-analysis"></div><div class="source-line">来源：${sourceLabel}${classificationLabel ? `<span class="auto-label">${esc(classificationLabel)}</span>` : ""}</div>`;
    window.dispatchEvent(new CustomEvent("vocab:current-word", { detail: { item, source } }));
  }

  function mergePersonalWords(items) {
    if (!Array.isArray(items)) return;
    const byWord = new Map(store.discovered.map(item => [norm(item.word), item]));
    items.forEach(item => {
      const previous = byWord.get(norm(item.word)) || {};
      byWord.set(norm(item.word), {
        ...previous,
        ...item,
        _source: item.source || previous._source,
        paraphraseExamContext: item.paraphraseExamContext || item.note || previous.paraphraseExamContext,
        _discovered: true
      });
    });
    store.discovered = [...byWord.values()];
    save("ielts_discovered", store.discovered);
    const refreshed = currentWord && store.discovered.find(item => norm(item.word) === norm(currentWord.word));
    if (refreshed && (refreshed.definition !== currentWord.definition || refreshed.updated_at !== currentWord.updated_at || JSON.stringify(refreshed.senses || []) !== JSON.stringify(currentWord.senses || []))) renderWord(refreshed, "个人词库 · 已更新词条");
    populateTopics();
    if (location.hash === "#library") {
      if (window.VocabStudy?.renderLibrary) window.VocabStudy.renderLibrary(true);
      else renderLibrary();
    }
    renderNotebook();
  }

  function populateTopics() {
    const topics = [...new Set(dataset().flatMap(item => [item.topic, ...(item.related_topics || [])]).filter(Boolean))].sort();
    $("#topic-filter").innerHTML = `<option value="all">全部话题</option>${topics.map(topic => `<option value="${attr(topic)}">${esc(topic)}</option>`).join("")}`;
  }

  function renderRows(items, target) {
    $(target).innerHTML = items.length ? items.map(item => `<article class="word-row" data-word="${attr(item.word)}"><h3>${esc(item.word)}</h3><p>${esc(item.definition)}</p><small>${esc(item.topic || "Vocabulary")}</small><span class="state">${store.mastered.includes(item.word) ? "✓" : store.review.includes(item.word) ? "•" : `B${esc(item.band || "6.5")}`}</span></article>`).join("") : `<div class="empty-state">这里还没有词汇。</div>`;
  }

  function renderLibrary() {
    const topic = $("#topic-filter").value;
    const minBand = Number($("#band-filter").value);
    const query = norm($("#library-search").value);
    const items = dataset().filter(item => item.study_eligible !== false && (topic === "all" || item.topic === topic || (item.related_topics || []).includes(topic)) && band(item) >= minBand && (!query || norm(item.word).includes(query) || norm(item.definition).includes(query)));
    $("#library-count").textContent = `${items.length} 词`;
    renderRows(items, "#library-list");
  }

  function renderQuiz() {
    const items = quizItems(); if (!items.length) return;
    quizIndex = (quizIndex + items.length) % items.length; const item = items[quizIndex];
    $("#quiz-question").textContent = item.low; $("#quiz-streak").textContent = quizStreak; $("#quiz-feedback").textContent = ""; $("#quiz-next").classList.add("hidden");
    $("#quiz-options").innerHTML = item.options.map(option => `<button class="quiz-option" data-option="${attr(option)}">${esc(option)}</button>`).join("");
  }

  function answerQuiz(option) {
    const item = quizItems()[quizIndex]; const correct = option === item.target;
    quizStreak = correct ? quizStreak + 1 : 0; $("#quiz-streak").textContent = quizStreak;
    $$(".quiz-option").forEach(button => { button.disabled = true; button.classList.toggle("correct", button.dataset.option === item.target); button.classList.toggle("wrong", button.dataset.option === option && !correct); });
    $("#quiz-feedback").textContent = `${correct ? "答对了。" : `正确答案是 ${item.target}。`} ${item.explanation || ""}`; $("#quiz-next").classList.remove("hidden"); markActivity(item.target);
  }

  function speak(text, button = null) {
    if (window.VocabSpeech) return window.VocabSpeech.speak(text, {button});
    if (!("speechSynthesis" in window)) return toast("当前浏览器不支持语音朗读");
    const voice = new SpeechSynthesisUtterance(text); voice.lang = "en-GB"; voice.rate = .82; speechSynthesis.speak(voice);
  }

  function renderNotebook() { renderRows(dataset().filter(item => store.saved.includes(item.word)), "#notebook-list"); }
  function toggleSave(word) { store.saved = store.saved.includes(word) ? store.saved.filter(x => x !== word) : [...store.saved, word]; save("ielts_saved_words", store.saved); updateStats(); const item = dataset().find(x => x.word === word); window.dispatchEvent(new CustomEvent("vocab:saved", {detail:{item,saved:store.saved.includes(word)}})); if (item) renderWord(item, item._source ? "在线词典" : "精选雅思词库"); toast(store.saved.includes(word) ? "已加入生词本" : "已移出生词本"); }

  function updateEngine(online) { proxyOnline = online; $("#engine-dot").classList.toggle("online", online); $("#engine-text").textContent = online ? "多词典代理已连接" : "本地词库 · 在线词典按需调用"; }

  async function probeProxy() {
    try {
      const apiBase = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
      const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1500) });
      updateEngine(response.ok);
    } catch { updateEngine(false); }
  }

  $$("[data-tab]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); switchTab(button.dataset.tab); }));
  $("#sidebar-toggle").addEventListener("click", () => {
    if (!sidebarMedia.matches) { document.body.classList.remove("menu-open"); return; }
    setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  });
  sidebarMedia.addEventListener?.("change", () => setSidebarCollapsed(sidebarPreference(), false));
  $("[data-mobile-menu]").addEventListener("click", () => document.body.classList.add("menu-open")); $("#mobile-overlay").addEventListener("click", () => document.body.classList.remove("menu-open"));
  $("#search-input").addEventListener("compositionstart", () => {
    searchComposing = true;
    clearTimeout(suggestionTimer);
    suggestionController?.abort();
    $("#suggestions").classList.remove("open");
  });
  $("#search-input").addEventListener("compositionend", event => {
    searchComposing = false;
    scheduleSuggestions(event.target.value, 0);
  });
  $("#search-input").addEventListener("input", event => {
    if (!searchComposing) scheduleSuggestions(event.target.value);
  });
  $("#search-form").addEventListener("submit", event => { event.preventDefault(); lookup($("#search-input").value); });
  $("#suggestions").addEventListener("click", event => { const button = event.target.closest("[data-word]"); if (button) lookup(button.dataset.word); });
  $("#word-detail").addEventListener("click", event => { const wordButton = event.target.closest("[data-word]"); const lookupButton = event.target.closest("[data-lookup-word]"); const saveButton = event.target.closest("[data-save]"); const speakButton = event.target.closest("[data-speak]"); const apiButton = event.target.closest("[data-open-api-settings]"); if (wordButton) lookup(wordButton.dataset.word); if (lookupButton) lookup(lookupButton.dataset.lookupWord); if (saveButton) toggleSave(saveButton.dataset.save); if (speakButton) speak(speakButton.dataset.speak, speakButton); if (apiButton) { switchTab("settings"); requestAnimationFrame(() => $("#settings-api")?.scrollIntoView({behavior:"smooth"})); } });
  $("#recommended-words").addEventListener("click", event => { const button = event.target.closest("[data-word]"); if (button) lookup(button.dataset.word); });
  ["#topic-filter", "#band-filter"].forEach(selector => $(selector).addEventListener("change", () => {
    if (!window.VocabStudy?.renderLibrary) renderLibrary();
  }));
  $("#library-search").addEventListener("input", () => {
    if (!window.VocabStudy?.renderLibrary) renderLibrary();
  });
  ["#library-list", "#notebook-list"].forEach(selector => $(selector).addEventListener("click", event => { const row = event.target.closest("[data-word]"); if (row) lookup(row.dataset.word); }));
  $("#quiz-options").addEventListener("click", event => { const button = event.target.closest("[data-option]"); if (button) answerQuiz(button.dataset.option); }); $("#quiz-next").addEventListener("click", () => { quizIndex++; renderQuiz(); });
  $("#clear-notebook").addEventListener("click", () => { if (!confirm("确定清空生词本吗？")) return; store.saved = []; save("ielts_saved_words", store.saved); renderNotebook(); updateStats(); });
  $("#reset-progress").addEventListener("click", () => { store.activity.lookups = 0; store.activity.studied = []; updateStats(); toast("今日进度已重置"); });
  document.addEventListener("click", event => { if (!event.target.closest(".search-stack")) $("#suggestions").classList.remove("open"); });
  window.addEventListener("hashchange", () => switchTab(location.hash.slice(1), false));
  setSidebarCollapsed(sidebarPreference(), false);

  window.VocabAtelier = {
    switchTab,
    lookup,
    toast,
    getCurrentWord: () => currentWord,
    getDataset: () => dataset(),
    mergePersonalWords,
    setSaved(word, enabled = true) {
      const has = store.saved.includes(word);
      if (enabled && !has) store.saved.push(word);
      if (!enabled && has) store.saved = store.saved.filter(item => item !== word);
      save("ielts_saved_words", store.saved); updateStats(); renderNotebook();
    },
    setStatus(word, status) {
      store.mastered = store.mastered.filter(item => item !== word);
      store.review = store.review.filter(item => item !== word);
      if (status === "mastered") store.mastered.push(word);
      if (status === "review") store.review.push(word);
      save("ielts_mastered", store.mastered); save("ielts_review", store.review); updateStats();
    }
  };

  populateTopics(); updateStats(); renderQuiz(); renderNotebook();
  probeProxy();
  const recommendations = shuffle(curated).slice(0, 5); $("#recommended-words").innerHTML = recommendations.map(item => `<button data-word="${attr(item.word)}">${esc(item.word)} · B${esc(item.band)}</button>`).join("");
  renderWord(curated.find(item => item.word === "alleviate") || curated[0], "精选雅思词库");
  switchTab(location.hash.slice(1) || "lookup", false);
})();
