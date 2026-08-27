(() => {
  "use strict";

  const API = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
  const HISTORY_KEY = "ielts_speaking_history_v1";
  const FALLBACK = {
    part1: {
      part: "part1", label: "Part 1", title: "熟悉话题问答", topic: "Hometown", context: "",
      summary: "3 道日常问题，每题约 45 秒。像和考官闲聊，但答案要完整。",
      prep_seconds: 0, answer_seconds: 45, target_words: {min: 40, max: 90},
      items: [
        {id: "hometown-0", prompt: "Where is your hometown, and what is it known for?", bullets: []},
        {id: "hometown-1", prompt: "What do you like most about living there?", bullets: []},
        {id: "hometown-2", prompt: "Has your hometown changed much in recent years?", bullets: []}
      ]
    },
    part2: {
      part: "part2", label: "Part 2", title: "个人陈述", topic: "Learning", context: "",
      summary: "1 分钟准备、2 分钟连续说。覆盖提示卡上的要点，并给出原因。",
      prep_seconds: 60, answer_seconds: 120, target_words: {min: 150, max: 260},
      items: [{
        id: "new-skill",
        prompt: "Describe a skill you would like to learn",
        bullets: ["what the skill is", "how you would learn it", "how long it might take", "and explain why this skill would be useful to you"]
      }]
    },
    part3: {
      part: "part3", label: "Part 3", title: "抽象讨论", topic: "Learning",
      context: "Describe a skill you would like to learn",
      summary: "2 至 3 道延伸问题，每题约 60 秒。先给立场，再解释，最后收束。",
      prep_seconds: 0, answer_seconds: 60, target_words: {min: 70, max: 140},
      items: [
        {id: "new-skill-p3-0", prompt: "Should schools spend more time teaching practical skills?", bullets: []},
        {id: "new-skill-p3-1", prompt: "Why do some adults find it harder to learn new things?", bullets: []},
        {id: "new-skill-p3-2", prompt: "How might technology change the way people learn in the future?", bullets: []}
      ]
    }
  };
  const PART_COPY = {
    part1: {eyebrow: "PART 1 · INTERVIEW", kicker: "45 秒 / 题"},
    part2: {eyebrow: "PART 2 · LONG TURN", kicker: "1 分钟准备 · 2 分钟作答"},
    part3: {eyebrow: "PART 3 · DISCUSSION", kicker: "60 秒 / 题"}
  };
  const state = {
    view: "home",
    set: null,
    index: 0,
    phase: "answer",
    remaining: 0,
    total: 0,
    answers: [],
    draft: "",
    notes: "",
    listening: false,
    loading: false,
    timer: 0,
    recognition: null
  };
  const $ = selector => document.querySelector(selector);
  const root = () => $("#view-speaking");
  const home = () => $("#speaking-home");
  const session = () => $("#speaking-session");
  const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const attr = value => esc(value).replace(/`/g, "&#96;");
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function toast(message) { window.VocabAtelier?.toast?.(message); }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {"Content-Type": "application/json", ...(options.headers || {})}
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `请求失败 (${response.status})`);
    return data;
  }

  function readHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value.slice(0, 8) : [];
    } catch {
      return [];
    }
  }

  function writeHistory(entry) {
    const next = [entry, ...readHistory().filter(item => item.id !== entry.id)].slice(0, 8);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
  }

  function clock(seconds) {
    const safe = Math.max(0, seconds | 0);
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function wordCount(text) {
    return (String(text || "").match(/[A-Za-z]+(?:'[A-Za-z]+)?|[\u3400-\u9fff]/g) || []).length;
  }

  function currentItem() {
    return state.set?.items?.[state.index] || null;
  }

  function stopListening() {
    try { state.recognition?.stop(); } catch { /* already stopped */ }
    state.listening = false;
  }

  function clearTimer() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = 0;
  }

  function pause() {
    clearTimer();
    stopListening();
  }

  function startTimer(seconds, onDone, total = 0) {
    clearTimer();
    const initial = Math.max(0, seconds | 0);
    state.total = total || initial;
    state.remaining = initial;
    const started = Date.now();
    const tick = () => {
      state.remaining = Math.max(0, initial - Math.floor((Date.now() - started) / 1000));
      renderTimer();
      if (state.remaining <= 0) {
        clearTimer();
        onDone();
      }
    };
    renderTimer();
    if (!initial) {
      onDone();
      return;
    }
    state.timer = window.setInterval(tick, 250);
  }

  function renderTimer() {
    const ring = $("#speaking-timer");
    const label = $("#speaking-clock");
    if (!ring || !label) return;
    const used = state.total ? ((state.total - state.remaining) / state.total) * 100 : 0;
    ring.style.setProperty("--p", `${Math.min(100, used)}%`);
    ring.classList.toggle("urgent", state.remaining <= 10 && state.phase !== "prep");
    label.textContent = clock(state.remaining);
  }

  function renderHome() {
    pause();
    state.view = "home";
    state.set = null;
    session().classList.add("hidden");
    home().classList.remove("hidden");
    const history = readHistory();
    home().innerHTML = `
      <div class="study-hero speaking-hero">
        <p class="eyebrow">SPEAKING BOOTH · TIMED</p>
        <h2>开口、计时、立刻知道卡在哪</h2>
        <p>Part 1 / 2 / 3 都按考场节奏走。可以打字，也可以在支持的浏览器里口答。没配 API 时仍可练；配好后会按流利度、词汇、语法和切题给保守分数，并给出可换上的表达。</p>
        <div class="speaking-part-grid">
          ${["part1","part2","part3"].map(part => {
            const copy = PART_COPY[part];
            const title = FALLBACK[part].title;
            return `<button type="button" class="speaking-part-card" data-start-part="${part}"><small>${esc(copy.eyebrow)}</small><b>${esc(title)}</b><span>${esc(copy.kicker)}</span></button>`;
          }).join("")}
        </div>
      </div>
      <div class="study-rules speaking-rules">
        <div><b>计时先于完美</b><span>到点就停。宁可结构完整，也不要说到一半被掐断。</span></div>
        <div><b>打字也算练</b><span>麦克风被拦截时，把要说的话写下来，反馈看的是内容而不是音频。</span></div>
        <div><b>分数故意保守</b><span>本地点评上限 6.0。考官式评分需要先在设置里接上模型。</span></div>
      </div>
      ${history.length ? `<section class="speaking-history"><p class="rail-label">最近练习</p>${history.map(item => `<button type="button" class="speaking-history-row" disabled><strong>${esc(item.label)}</strong><span>Band ${esc(item.band)}</span><small>${esc(item.topic)} · ${esc(item.when)}</small></button>`).join("")}</section>` : ""}
    `;
  }

  function showSession() {
    home().classList.add("hidden");
    session().classList.remove("hidden");
  }

  function promptMarkup(item) {
    const bullets = item.bullets?.length
      ? `<ul class="speaking-bullets">${item.bullets.map(point => `<li>${esc(point)}</li>`).join("")}</ul>`
      : "";
    const context = state.set.context ? `<p class="speaking-context">延伸自：${esc(state.set.context)}</p>` : "";
    return `${context}<h2>${esc(item.prompt)}</h2>${bullets}`;
  }

  function renderPrep() {
    const item = currentItem();
    state.view = "session";
    state.phase = "prep";
    showSession();
    session().innerHTML = `
      <article class="study-card speaking-card">
        <div class="session-progress speaking-progress">
          <span>${esc(state.set.label)}</span>
          <div class="speaking-timer" id="speaking-timer" style="--p:0%"><b id="speaking-clock">${clock(state.set.prep_seconds)}</b></div>
          <em>准备</em>
        </div>
        <p class="eyebrow">CUE CARD</p>
        ${promptMarkup(item)}
        <label class="speaking-field"><span>准备笔记（不算作答）</span><textarea id="speaking-notes" rows="5" maxlength="2000" placeholder="写下关键词，不要写整段稿。">${esc(state.notes)}</textarea></label>
        <div class="recall-actions"><button class="primary" data-begin-answer type="button">提前开始作答</button></div>
      </article>
    `;
    $("#speaking-notes")?.addEventListener("input", event => { state.notes = event.target.value; });
    startTimer(state.set.prep_seconds, beginAnswer);
  }

  function renderAnswer() {
    const item = currentItem();
    const total = state.set.items.length;
    state.view = "session";
    state.phase = "answer";
    showSession();
    session().innerHTML = `
      <article class="study-card speaking-card">
        <div class="session-progress speaking-progress">
          <span>${esc(state.set.label)} · ${state.index + 1}/${total}</span>
          <div class="speaking-timer" id="speaking-timer" style="--p:0%"><b id="speaking-clock">${clock(state.set.answer_seconds)}</b></div>
          <em>作答</em>
        </div>
        <p class="eyebrow">${esc(state.set.topic)}</p>
        ${promptMarkup(item)}
        ${state.notes ? `<p class="speaking-notes-preview">笔记：${esc(state.notes)}</p>` : ""}
        <label class="speaking-field"><span>你的回答 · 英文</span><textarea id="speaking-answer" rows="7" maxlength="8000" placeholder="直接说或写。先回答问题，再补一个原因和一个例子。">${esc(state.draft)}</textarea></label>
        <div class="speaking-answer-meta"><span id="speaking-word-count">${wordCount(state.draft)} 词</span><span>目标 ${state.set.target_words.min}–${state.set.target_words.max} 词</span></div>
        <div class="recall-actions">
          <button class="secondary" data-toggle-listen type="button">${state.listening ? "停止口答" : "开始口答"}</button>
          <button class="quiet-button" data-abort-set type="button">结束本轮</button>
          <button class="primary" data-submit-answer type="button">提交并点评</button>
        </div>
        <p class="speaking-hint" id="speaking-mic-hint">口答使用浏览器语音识别，音频不会上传。若麦克风被拦截，直接打字即可。</p>
      </article>
    `;
    $("#speaking-answer")?.addEventListener("input", event => {
      state.draft = event.target.value;
      const count = $("#speaking-word-count");
      if (count) count.textContent = `${wordCount(state.draft)} 词`;
    });
    startTimer(state.set.answer_seconds, () => submitAnswer({auto: true}));
  }

  function renderFeedback(record) {
    const feedback = record.feedback;
    const source = record.source === "ai" ? "模型点评" : record.source === "local_fallback" ? "本地点评（模型未响应）" : "本地点评";
    const criteria = [["fluency", "流利度"], ["vocabulary", "词汇"], ["grammar", "语法"], ["task", "切题"]];
    showSession();
    session().innerHTML = `
      <article class="study-results speaking-results">
        <p class="eyebrow">EXAMINER NOTES · ${esc(source)}</p>
        <h2>本题约 Band ${esc(feedback.band_overall)}</h2>
        ${feedback.notice ? `<p class="speaking-notice">${esc(feedback.notice)}</p>` : ""}
        <div class="result-metrics">${criteria.map(([key, label]) => `<div><b>${esc(feedback[key].band)}</b><span>${label}</span></div>`).join("")}<div><b>${esc(feedback.word_count ?? wordCount(record.answer))}</b><span>词数</span></div></div>
        <div class="speaking-comments">${criteria.map(([key, label]) => `<p><b>${label}</b>${esc(feedback[key].comment)}</p>`).join("")}</div>
        <div class="speaking-upgrades"><small>可以立刻换上的表达</small>${feedback.upgrades.map(item => `<div><strong>${esc(item.from)} → ${esc(item.to)}</strong><span>${esc(item.why)}</span></div>`).join("")}</div>
        <blockquote class="speaking-model"><small>示范回答</small>${esc(feedback.model_answer)}</blockquote>
        <div class="recall-actions">
          ${state.index + 1 < state.set.items.length ? `<button class="primary" data-next-item type="button">下一题</button>` : `<button class="primary" data-finish-set type="button">完成本轮</button>`}
          <button class="quiet-button" data-abort-set type="button">回首页</button>
        </div>
      </article>
    `;
  }

  function renderSummary() {
    const scored = state.answers.filter(item => item.feedback);
    const average = scored.length
      ? Math.round((scored.reduce((sum, item) => sum + Number(item.feedback.band_overall || 0), 0) / scored.length) * 2) / 2
      : "—";
    writeHistory({
      id: `${Date.now()}`,
      label: state.set.label,
      topic: state.set.topic,
      band: average,
      when: new Date().toLocaleString("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"})
    });
    showSession();
    session().innerHTML = `
      <article class="study-results speaking-results">
        <p class="eyebrow">SESSION COMPLETE</p>
        <h2>${esc(state.set.label)} 这一轮结束了</h2>
        <div class="result-metrics"><div><b>${esc(average)}</b><span>平均 Band</span></div><div><b>${scored.length}</b><span>已点评</span></div><div><b>${esc(state.set.topic)}</b><span>话题</span></div></div>
        <div class="speaking-comments">${scored.map(item => `<p><b>${esc(item.prompt)}</b>Band ${esc(item.feedback.band_overall)}</p>`).join("")}</div>
        <div class="recall-actions"><button class="primary" data-abort-set type="button">再练一轮</button></div>
      </article>
    `;
  }

  function beginAnswer() {
    clearTimer();
    const notes = $("#speaking-notes");
    if (notes) state.notes = notes.value;
    state.draft = state.answers[state.index]?.answer || "";
    renderAnswer();
  }

  function toggleListen() {
    const hint = $("#speaking-mic-hint");
    if (!Recognition) {
      if (hint) hint.textContent = "当前浏览器没有语音识别，请打字作答。Safari / 部分内核需要改用 Chrome。";
      toast("当前浏览器不支持口答，请打字");
      return;
    }
    if (state.listening) {
      stopListening();
      const button = $("[data-toggle-listen]");
      if (button) button.textContent = "开始口答";
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;
    let committed = state.draft ? `${state.draft.trim()} ` : "";
    recognition.onresult = event => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const piece = event.results[index][0].transcript;
        if (event.results[index].isFinal) committed += `${piece.trim()} `;
        else interim += piece;
      }
      const box = $("#speaking-answer");
      state.draft = `${committed}${interim}`.replace(/\s+/g, " ").trim();
      if (box) box.value = state.draft;
      const count = $("#speaking-word-count");
      if (count) count.textContent = `${wordCount(state.draft)} 词`;
    };
    recognition.onerror = event => {
      stopListening();
      const button = $("[data-toggle-listen]");
      if (button) button.textContent = "开始口答";
      if (hint) hint.textContent = event.error === "not-allowed" ? "麦克风被拒绝或当前站点禁用了麦克风，请打字作答。" : "口答中断，可以继续打字。";
    };
    recognition.onend = () => {
      state.listening = false;
      const button = $("[data-toggle-listen]");
      if (button && state.phase === "answer") button.textContent = "开始口答";
    };
    try {
      recognition.start();
      state.recognition = recognition;
      state.listening = true;
      const button = $("[data-toggle-listen]");
      if (button) button.textContent = "停止口答";
    } catch (err) {
      if (hint) hint.textContent = "无法启动麦克风，请打字作答。";
      toast("无法启动口答");
    }
  }

  async function submitAnswer({auto = false} = {}) {
    if (state.loading || state.phase !== "answer") return;
    const box = $("#speaking-answer");
    if (box) state.draft = box.value;
    const answer = state.draft.trim();
    if (!auto && wordCount(answer) < 8 && !confirm("回答还很短，确定现在提交吗？")) return;
    const item = currentItem();
    pause();
    state.loading = true;
    state.phase = "feedback";
    session().innerHTML = `<article class="study-card speaking-card"><p class="eyebrow">MARKING</p><h2>正在点评这道题</h2><p>先看切题和能换上的表达，分数会偏保守。</p></article>`;
    const payload = {part: state.set.part, topic: state.set.topic, prompt: item.prompt, bullets: item.bullets, answer};
    let record = {prompt: item.prompt, answer, source: "local", feedback: null};
    try {
      const result = await api("/api/speaking/feedback", {method: "POST", body: JSON.stringify(payload)});
      record = {prompt: item.prompt, answer, source: result.source, feedback: result.feedback};
    } catch (err) {
      toast(err.message || "点评失败，已改用本地点评");
      record.feedback = {
        band_overall: 5.0,
        fluency: {band: 5.0, comment: "后端暂时不可用，先保留作答。"},
        vocabulary: {band: 5.0, comment: "请用 start.sh 打开应用后再获取完整点评。"},
        grammar: {band: 5.0, comment: "本地页面无法调用评分接口。"},
        task: {band: 5.0, comment: "作答已保存，可稍后重试。"},
        upgrades: [
          {from: "I think", to: "I would argue that", why: "立场更清楚。"},
          {from: "a lot of", to: "a considerable number of", why: "数量词更准。"},
          {from: "very good", to: "particularly worthwhile", why: "评价更具体。"},
          {from: "because", to: "mainly because", why: "因果更有层次。"}
        ],
        model_answer: "I would answer the question directly, add one reason, and finish with a short example so the idea is complete.",
        word_count: wordCount(answer),
        notice: err.message || "评分接口不可用。"
      };
    }
    state.answers[state.index] = record;
    state.loading = false;
    renderFeedback(record);
  }

  async function startPart(part) {
    pause();
    state.index = 0;
    state.answers = [];
    state.draft = "";
    state.notes = "";
    state.loading = false;
    try {
      state.set = await api(`/api/speaking/set?part=${encodeURIComponent(part)}`);
    } catch {
      state.set = FALLBACK[part] || FALLBACK.part1;
      toast("题库接口未连接，已使用离线题目");
    }
    if (state.set.prep_seconds > 0) renderPrep();
    else beginAnswer();
  }

  function nextItem() {
    state.index += 1;
    state.draft = "";
    state.notes = "";
    if (!currentItem()) {
      renderSummary();
      return;
    }
    if (state.set.prep_seconds > 0) renderPrep();
    else beginAnswer();
  }

  function onClick(event) {
    const start = event.target.closest("[data-start-part]");
    if (start) return startPart(start.dataset.startPart);
    if (event.target.closest("[data-begin-answer]")) return beginAnswer();
    if (event.target.closest("[data-toggle-listen]")) return toggleListen();
    if (event.target.closest("[data-submit-answer]")) return submitAnswer();
    if (event.target.closest("[data-next-item]")) return nextItem();
    if (event.target.closest("[data-finish-set]")) return renderSummary();
    if (event.target.closest("[data-abort-set]")) return renderHome();
  }

  function activate() {
    if (state.view === "home" || !state.set) {
      renderHome();
      return;
    }
    if (state.phase === "prep") {
      if (!$("#speaking-notes")) renderPrep();
      else startTimer(state.remaining || state.set.prep_seconds, beginAnswer, state.set.prep_seconds);
      return;
    }
    if (state.phase === "answer") {
      if (!$("#speaking-answer")) renderAnswer();
      else startTimer(state.remaining || state.set.answer_seconds, () => submitAnswer({auto: true}), state.set.answer_seconds);
      return;
    }
    if (state.phase === "feedback" && state.answers[state.index] && !$(".speaking-results")) renderFeedback(state.answers[state.index]);
  }

  function bind() {
    const view = root();
    if (!view || view.dataset.bound === "true") return;
    view.dataset.bound = "true";
    view.addEventListener("click", onClick);
    window.addEventListener("hashchange", () => {
      if (location.hash === "#speaking") activate();
      else pause();
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  }

  bind();
  window.VocabSpeaking = {activate, pause};
  if (location.hash === "#speaking") activate();
})();
