(() => {
  "use strict";

  const API = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
  const state = {
    settings: null, catalogs: [], dashboard: null, session: null,
    introduced: new Set(), phase: "prompt", recallMode: "options",
    hints: [], replays: 0, startedAt: 0, timerTimeout: null, submitting: false, results: [], libraryCursor: null,
    libraryWords: [], libraryTimer: null,
    profileDraft: {avatar: null, background: null},
    crop: null,
    coreRefreshedAt: 0, coreRefreshPromise: null,
    libraryRefreshedAt: 0, libraryKey: "", libraryRefreshPromise: null,
    libraryRequestToken: 0
  };
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const attr = value => esc(value).replace(/`/g, "&#96;");
  const DEFAULT_APPEARANCE = {profile_name:"学习者", avatar_version:0, background_version:0, background_enabled:false, background_overlay:.72, button_color:"#9fe7c5"};

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, { ...options, headers: {"Content-Type":"application/json", ...(options.headers || {})} });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `请求失败 (${response.status})`);
    return data;
  }

  function error(target, message) {
    const el = $(target); if (el) el.innerHTML = `<div class="empty-state">${esc(message)}<br><small>请确认使用 start.sh 打开应用，而不是直接双击 index.html。</small></div>`;
  }

  async function refreshCore({ force = false } = {}) {
    if (!force && state.settings && state.dashboard && Date.now() - state.coreRefreshedAt < 30_000) return state;
    if (state.coreRefreshPromise) return state.coreRefreshPromise;
    const request = (async () => {
      try {
        const [settingsData, catalogData, dashboard] = await Promise.all([api("/api/settings"), api("/api/catalogs"), api("/api/study/dashboard")]);
        state.settings = settingsData.settings;
        state.catalogs = catalogData.catalogs || [];
        state.dashboard = dashboard;
        state.coreRefreshedAt = Date.now();
        window.VocabSpeech?.configure({provider:state.settings.voice_provider, lang:state.settings.voice_lang, voiceName:state.settings.voice_name, rate:state.settings.speech_rate});
        applyAppearance(state.settings);
        updateGlobalProgress();
        return state;
      } catch (err) {
        state.settings ||= {...DEFAULT_APPEARANCE, enabled_catalogs:["ielts"], paused_catalogs:[], daily_new_limit:20, desired_retention:.9, filter_basic_words:true, dictation_count:10, voice_provider:"google", voice_lang:"en-GB", speech_rate:.82, autoplay:true};
        throw err;
      }
    })();
    state.coreRefreshPromise = request;
    try { return await request; }
    finally { if (state.coreRefreshPromise === request) state.coreRefreshPromise = null; }
  }

  function profileImageUrl(kind, version) {
    return Number(version) > 0 ? `${API}/api/profile/image?kind=${kind}&v=${encodeURIComponent(version)}` : "";
  }

  function profileInitials(name) {
    const compact = String(name || "学习者").replace(/\s+/g, "");
    return Array.from(compact).slice(0, 2).join("") || "学习";
  }

  function validColor(value) {
    const color = String(value || "").toLowerCase();
    return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_APPEARANCE.button_color;
  }

  function colorDetails(hex) {
    const color = validColor(hex);
    const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    const linear = rgb.map(value => { const channel=value/255; return channel <= .03928 ? channel/12.92 : ((channel+.055)/1.055)**2.4; });
    const luminance = .2126*linear[0] + .7152*linear[1] + .0722*linear[2];
    const darkened = rgb.map(value => Math.round(value * .42));
    return {color, rgb:rgb.join(","), contrast:luminance > .42 ? "#102119" : "#f7f5ee", dark:`#${darkened.map(value=>value.toString(16).padStart(2,"0")).join("")}`, iconFilter:luminance > .42 ? "brightness(0) saturate(100%)" : "brightness(0) invert(1)"};
  }

  function applyAppearance(settings = state.settings) {
    if (!settings) return;
    const s = {...DEFAULT_APPEARANCE, ...settings};
    const name = String(s.profile_name || DEFAULT_APPEARANCE.profile_name).trim() || DEFAULT_APPEARANCE.profile_name;
    const initials = profileInitials(name);
    document.querySelectorAll("[data-profile-name]").forEach(node => { node.textContent = name; });
    document.querySelectorAll("[data-profile-initials]").forEach(node => { node.textContent = initials; });
    const avatar = state.profileDraft.avatar || profileImageUrl("avatar", s.avatar_version);
    document.querySelectorAll("[data-profile-avatar]").forEach(image => {
      if (avatar) { image.src = avatar; image.hidden = false; }
      else { image.removeAttribute("src"); image.hidden = true; }
    });

    const details = colorDetails(s.button_color);
    const root = document.documentElement.style;
    root.setProperty("--accent", details.color); root.setProperty("--accent-rgb", details.rgb);
    root.setProperty("--accent-dark", details.dark); root.setProperty("--accent-contrast", details.contrast);
    root.setProperty("--accent-icon-filter", details.iconFilter);

    const background = state.profileDraft.background || profileImageUrl("background", s.background_version);
    const useBackground = Boolean(s.background_enabled && background);
    document.body.classList.toggle("has-custom-background", useBackground);
    document.body.style.setProperty("--profile-overlay", String(Math.max(.45, Math.min(.92, Number(s.background_overlay) || .72))));
    document.body.style.setProperty("--profile-background", useBackground ? `url("${background}")` : "none");
  }

  function currentAppearanceDraft() {
    return {...state.settings,
      profile_name:$("#setting-profile-name")?.value || state.settings.profile_name,
      background_enabled:$("#setting-background-enabled")?.checked ?? state.settings.background_enabled,
      background_overlay:Number($("#setting-background-overlay")?.value || state.settings.background_overlay),
      button_color:$("#setting-button-color")?.value || state.settings.button_color,
    };
  }

  function renderAppearancePreviews(settings = state.settings) {
    if (!settings) return;
    const s = {...DEFAULT_APPEARANCE, ...settings};
    const name = $("#setting-profile-name")?.value || s.profile_name;
    $("#setting-avatar-initials").textContent = profileInitials(name);
    const avatar = state.profileDraft.avatar || profileImageUrl("avatar", s.avatar_version);
    const avatarImage = $("#setting-avatar-preview");
    if (avatar) { avatarImage.src=avatar; avatarImage.hidden=false; } else { avatarImage.removeAttribute("src"); avatarImage.hidden=true; }
  }

  function constrainCropOffset(crop) {
    const canvas=$("#crop-canvas"), scale=crop.baseScale*crop.zoom;
    const extraX=Math.max(0,(crop.image.naturalWidth*scale-canvas.width)/2), extraY=Math.max(0,(crop.image.naturalHeight*scale-canvas.height)/2);
    crop.offsetX=Math.max(-extraX,Math.min(extraX,crop.offsetX)); crop.offsetY=Math.max(-extraY,Math.min(extraY,crop.offsetY));
  }

  function drawCrop() {
    const crop=state.crop; if(!crop)return;
    const canvas=$("#crop-canvas"), context=canvas.getContext("2d",{alpha:false}), scale=crop.baseScale*crop.zoom;
    constrainCropOffset(crop); context.fillStyle="#0d100f"; context.fillRect(0,0,canvas.width,canvas.height);
    const width=crop.image.naturalWidth*scale,height=crop.image.naturalHeight*scale;
    context.drawImage(crop.image,(canvas.width-width)/2+crop.offsetX,(canvas.height-height)/2+crop.offsetY,width,height);
  }

  async function openProfileCropper(kind, file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type) || file.size > 12_000_000) return window.VocabAtelier?.toast("请选择 12MB 以内的 JPG、PNG 或 WebP 图片");
    const source=URL.createObjectURL(file), image=new Image(); image.src=source;
    try { await image.decode(); }
    catch { URL.revokeObjectURL(source); return window.VocabAtelier?.toast("照片无法读取，请换一张图片"); }
    const canvas=$("#crop-canvas"), avatar=kind === "avatar";
    canvas.width=avatar?512:1600; canvas.height=avatar?512:1000;
    state.crop={kind,image,source,zoom:1,offsetX:0,offsetY:0,baseScale:Math.max(canvas.width/image.naturalWidth,canvas.height/image.naturalHeight),dragging:false,lastX:0,lastY:0};
    $("#crop-title").textContent=avatar?"裁剪个人头像":"裁剪背景照片";
    $("#crop-copy").textContent=avatar?"拖动照片，让主要人物位于圆形安全区内。":"拖动并缩放照片，选择整个页面要显示的区域。";
    $("#crop-stage").classList.toggle("avatar-crop",avatar); $("#crop-zoom").value="1"; $("#crop-status").textContent="";
    $("#profile-cropper").classList.add("open"); $("#profile-cropper").setAttribute("aria-hidden","false"); document.body.classList.add("crop-open");
    drawCrop();
  }

  function closeProfileCropper() {
    const kind=state.crop?.kind;
    if(state.crop?.source)URL.revokeObjectURL(state.crop.source); state.crop=null;
    if(kind && state.profileDraft[kind]) {
      state.profileDraft[kind]=null;
      renderAppearancePreviews(currentAppearanceDraft());
      applyAppearance(currentAppearanceDraft());
    }
    $("#profile-cropper").classList.remove("open"); $("#profile-cropper").setAttribute("aria-hidden","true"); document.body.classList.remove("crop-open");
    $("#setting-avatar-file").value=""; $("#setting-background-file").value="";
  }

  async function saveCroppedProfileImage() {
    if(!state.crop)return;
    const kind=state.crop.kind,status=$("#crop-status"),confirmButton=$("#crop-confirm"); confirmButton.disabled=true;
    try {
      status.textContent=kind === "avatar"?"正在保存头像…":"正在保存并启用背景…"; status.className="form-status";
      const dataUrl=$("#crop-canvas").toDataURL("image/jpeg",kind === "avatar"?.88:.84);
      if(dataUrl.length>4_000_000)throw new Error("裁剪后的照片仍然过大，请缩小原图后重试");
      state.profileDraft[kind]=dataUrl; renderAppearancePreviews(currentAppearanceDraft()); applyAppearance(currentAppearanceDraft());
      const uploaded=await api("/api/profile/image",{method:"POST",body:JSON.stringify({kind,data_url:dataUrl})}); state.settings=uploaded.settings;
      if(kind === "background") { const enabled=await api("/api/settings",{method:"PATCH",body:JSON.stringify({background_enabled:true})}); state.settings=enabled.settings; }
      state.profileDraft[kind]=null; closeProfileCropper(); renderSettingsSync(); applyAppearance(state.settings);
      $("#profile-form-status").textContent=kind === "avatar"?"头像已按选定区域保存。":"背景照片已按选定区域保存并启用。"; $("#profile-form-status").className="form-status success";
      window.VocabAtelier?.toast(kind === "avatar"?"头像已保存":"背景照片已保存并启用");
    } catch(err) { status.textContent=`保存失败：${err.message}`; status.className="form-status error"; }
    finally { confirmButton.disabled=false; }
  }

  async function selectProfileImage(kind, file) {
    const status=$("#profile-form-status");
    try {
      status.textContent=""; status.className="form-status"; await openProfileCropper(kind,file);
    } catch (err) {
      status.textContent=`照片读取失败：${err.message}`; status.className="form-status error";
      window.VocabAtelier?.toast(err.message);
    }
  }

  function updateGlobalProgress() {
    if (!state.dashboard) return;
    const complete = state.dashboard.reviewed_today + state.dashboard.new_words_today;
    const goal = Math.max(1, state.dashboard.due_total + state.dashboard.new_limit);
    const score = Math.min(100, Math.round(complete / goal * 100));
    $("#daily-progress").textContent = `${score}%`;
    $("#daily-ring").style.setProperty("--p", `${score}%`);
    $("#daily-copy").textContent = `${state.dashboard.reviewed_today} 次复习 + ${state.dashboard.new_words_today} 个新词`;
    $("#streak-days").textContent = `${state.dashboard.streak || 0} 天`;
  }

  function hideStudyExtras() {
    $("#study-paraphrase")?.classList.add("hidden");
    $("#study-dictation")?.classList.add("hidden");
    $("#study-home")?.classList.remove("hidden");
  }

  function clearKnowTimer() {
    if (state.timerTimeout) { clearTimeout(state.timerTimeout); state.timerTimeout = null; }
  }

  async function renderStudy() {
    try { await refreshCore(); }
    catch (err) { error("#study-home", err.message); return; }
    const d = state.dashboard;
    if (!state.session) {
      const active = d.active_sessions || {};
      const id = active.learn || active.review;
      if (id) await restoreSession(id);
    }
    if (state.session?.status === "active" && state.session.mode !== "dictation") return renderCurrentTask();
    hideStudyExtras();
    $("#study-session").classList.add("hidden");
    const books = (state.catalogs || []).filter(catalog => (state.settings.enabled_catalogs || []).includes(catalog.id));
    const bookNames = books.map(catalog => catalog.name).join(" · ") || "还没选词书";
    const remainingNew = Math.max(0, d.new_limit - d.new_words_today);
    const reviewCount = d.due?.meaning || 0;
    const learnCount = Math.min(10, remainingNew);
    const reviewGroup = Math.min(10, reviewCount);
    $("#study-summary").innerHTML = `<span><b>${reviewCount}</b> 待复习</span><span><b>${d.new_words_today}/${d.new_limit}</b> 新词</span>`;
    $("#study-home").innerHTML = `<div class="study-hero"><p class="eyebrow">TODAY · ${esc(bookNames)}</p><h2>${reviewCount || remainingNew ? (reviewCount ? `先复习 ${reviewCount} 个到期词` : `今天还可以新学 ${remainingNew} 个`) : "今日学习已完成"}</h2><p>看英文能不能立刻想起意思。选错、点不认识或来不及，都算不熟，会马上再考。连续答对 3 次才算这组记住，一组认完再拼写。</p><div class="study-today-metrics"><div><b>${reviewCount}</b><span>待复习</span></div><div><b>${remainingNew}</b><span>待学新词</span></div><div><b>${d.due?.spelling || 0}</b><span>自由听写可练</span></div></div><div class="study-actions"><button class="primary" data-start-review ${reviewCount ? "" : "disabled"}>${reviewCount ? `先复习 ${reviewGroup} 个` : "暂无到期复习"}</button><button class="${reviewCount ? "secondary" : "primary"}" data-start-learn ${remainingNew ? "" : "disabled"}>${remainingNew ? `学新词 ${learnCount} 个` : "今日新词已满"}</button></div></div><div class="study-rules"><div><b>1. 检查</b><span>先闭卷看英选中。对错当时判定，不靠事后给自己打分。</span></div><div><b>2. 记住 / 不熟</b><span>连续答对才记住；选错、模糊或超时就是不熟，计数归零并留在本组。</span></div><div><b>3. 拼写</b><span>一组词都记住后才拼。复习日期在本组结束后才排。</span></div></div><div class="study-extras"><button class="secondary" type="button" data-open-paraphrase>同义替换加练</button><button class="quiet-button" type="button" data-open-dictation>自由听写</button></div>`;
  }

  function renderReview() { return renderStudy(); }

  function openParaphrase() {
    $("#study-home").classList.add("hidden");
    $("#study-session").classList.add("hidden");
    $("#study-dictation")?.classList.add("hidden");
    $("#study-paraphrase").classList.remove("hidden");
    window.VocabAtelier && (location.hash === "#paraphrase" || history.replaceState(null, "", "#paraphrase"));
  }

  function openDictation() { return renderDictation(); }

  async function startSession(mode, extra = {}) {
    hideStudyExtras();
    const target = "#study-home";
    $(target).innerHTML = `<div class="loading-line">正在生成今日学习队列…</div>`;
    try {
      const data = await api("/api/study/sessions", {method:"POST", body:JSON.stringify({mode, catalogs:state.settings.enabled_catalogs, ...extra})});
      state.session = data.session; state.introduced.clear(); hydrateResults();
      if (!state.session.total) {
        $(target).innerHTML = `<div class="empty-state">当前词书没有可学的词。去设置里先选词书，再定每天新学几个。</div>`;
        return;
      }
      renderCurrentTask();
    } catch (err) { error(target, err.message); }
  }

  function currentTask() {
    if (state.session?.engine === "group") return state.session.current;
    return state.session?.queue?.[state.session.current_index];
  }

  function hydrateResults() {
    state.results = (state.session?.attempts || []).map(attempt => ({
      correct: attempt.correct, corrected: attempt.corrected, rating: attempt.rating_name,
      duration_ms: attempt.duration_ms, replays: attempt.replays, task: attempt.task
    }));
  }

  async function restoreSession(id) {
    try { const data=await api(`/api/study/sessions/${id}`);state.session=data.session;hydrateResults(); }
    catch { state.session=null;state.results=[]; }
  }

  function taskHeader(task) {
    if (state.session?.engine === "group") {
      const progress = state.session.progress || {};
      const total = Math.max(1, progress.total || state.session.total || 1);
      const spelling = progress.phase === "spelling";
      const count = spelling ? `${progress.spelling_done || 0} / ${progress.spelling_total || total}` : `${progress.remembered || 0} / ${total}`;
      const value = spelling
        ? Math.round((progress.spelling_done || 0) / Math.max(1, progress.spelling_total || total) * 100)
        : Math.round((progress.remembered || 0) / total * 100);
      const phase = spelling ? "拼写" : (state.session.mode === "review" ? "复习" : "学新词");
      return `<div class="session-progress"><span>${count} 已记住</span><progress max="100" value="${Math.max(0, Math.min(100, value))}"></progress><em>${phase}${task?.unfamiliar ? " · 不熟" : ""}</em></div>`;
    }
    const index = state.session.current_index + 1;
    return `<div class="session-progress"><span>${index} / ${state.session.total}</span><progress max="100" value="${Math.max(0,Math.min(100,Math.round(index / state.session.total * 100)))}"></progress><em>${task.card_type === "meaning" ? "词义" : "拼写"}${task.review_kind === "free" ? " · 自由练习" : task.is_new ? " · 新词" : " · 到期"}</em></div>`;
  }

  function streakLights(task) {
    const needed = Number(task?.needed || 3);
    const streak = Number(task?.streak || 0);
    return `<div class="streak-lights" aria-label="连续答对 ${streak}/${needed}">${Array.from({length: needed}, (_, index) => `<span class="${index < streak ? "on" : "off"}">●</span>`).join("")}</div>`;
  }

  function introHtml(task) {
    const word = task.word;
    const example = word.examples?.[0];
    return `${taskHeader(task)}<article class="study-card intro-card"><p class="eyebrow">NEW WORD · 先理解再首测</p><h2>${esc(word.word)} <small>${esc(word.phonetic || "")}</small></h2><p class="intro-definition"><b>${esc(word.pos || "词汇")}</b>${esc(word.definition)}</p>${word.collocations?.length ? `<p class="intro-line"><span>搭配</span>${word.collocations.slice(0,4).map(esc).join(" · ")}</p>` : ""}${example ? `<blockquote>${esc(example.en)}${example.cn ? `<small>${esc(example.cn)}</small>` : ""}</blockquote>` : ""}<button class="primary" data-begin-test>开始首测</button></article>`;
  }

  function meaningPrompt(task) {
    const word = task.word;
    const context = word.examples?.[0]?.en;
    return `${taskHeader(task)}<article class="study-card recall-card"><p class="eyebrow">先不要看释义</p><h2>${esc(word.word)}</h2><p class="phonetic-line">${esc(word.pos || "词汇")} · ${esc(word.phonetic || "")}</p>${context ? `<blockquote>${esc(context.replace(/\*\*/g,""))}</blockquote>` : ""}<div class="recall-actions"><button class="primary" data-recall="recall">想起来了</button><button class="secondary" data-recall="options">需要选项</button><button class="text-button" data-skip>跳过</button></div></article>`;
  }

  function playWordButton(word, extra = "") {
    return `<button class="audio-button audio-button-compact" type="button" data-replay-word="${attr(word)}" aria-label="播放 ${attr(word)} 发音"${extra}><img src="assets/graphic-eq-round.svg" alt="" aria-hidden="true"></button>`;
  }

  function meaningOptions(task) {
    const lights = state.session?.engine === "group" ? streakLights(task) : "";
    const word = task.word;
    return `${taskHeader(task)}${lights}<article class="study-card option-card"><p class="eyebrow">看英选中</p><div class="study-word-head"><h2>${esc(word.word)}</h2>${playWordButton(word.word)}<p class="phonetic-line">${esc(word.pos || "词汇")} · ${esc(word.phonetic || "")}</p></div><div class="meaning-options">${(task.options || []).map(option => `<button data-meaning-answer="${attr(option)}">${esc(option)}</button>`).join("")}</div></article>`;
  }

  function knowCheck(task, withFuzzy) {
    const seconds = withFuzzy ? 3 : 4;
    const word = task.word;
    return `${taskHeader(task)}${streakLights(task)}<article class="study-card recall-card"><p class="eyebrow">${withFuzzy ? "3 秒内判断熟不熟" : "还认识这个词吗"}</p><div class="study-word-head study-word-head-center"><h2>${esc(word.word)}</h2>${playWordButton(word.word)}<p class="phonetic-line">${esc(word.pos || "词汇")} · ${esc(word.phonetic || "")}</p></div><div class="know-timer" style="--know-seconds:${seconds}s"><span></span></div><div class="recall-actions"><button class="primary" data-know-answer="know">认识</button>${withFuzzy ? `<button class="secondary" data-know-answer="fuzzy">模糊</button>` : ""}<button class="text-button" data-know-answer="unknown">不认识</button></div></article>`;
  }

  function spellingPrompt(task) {
    const word = task.word;
    const first = esc(word.word.charAt(0));
    return `${taskHeader(task)}<article class="study-card spelling-card"><button class="audio-button audio-button-training" data-replay aria-label="播放 ${attr(word.word)} 发音"><img src="assets/graphic-eq-round.svg" alt="" aria-hidden="true"><span>播放${state.replays ? ` · ${state.replays + 1}` : ""}</span></button><p><b>${esc(word.pos || "词汇")}</b> · ${esc(word.definition)}</p><div class="hint-row"><button class="text-button" data-hint="first">提示首字母</button><button class="text-button" data-hint="length">提示长度</button><span id="spelling-hint">${state.hints.includes("first") ? `首字母 ${first}` : ""}${state.hints.includes("length") ? `${state.hints.length ? " · " : ""}${word.word.length} 个字符` : ""}</span></div><form id="study-spelling-form"><input id="study-spelling-input" autocomplete="off" spellcheck="false" placeholder="输入听到的单词或短语"><button class="primary">提交</button></form><label class="easy-check"><input type="checkbox" id="spelling-easy">无需思考就能准确拼出（太简单）</label><button class="text-button" data-skip>跳过</button></article>`;
  }

  function renderCurrentTask() {
    const task = currentTask();
    const home = $("#study-home");
    const box = $("#study-session");
    clearKnowTimer();
    if (!task || state.session?.status === "complete") return renderResults();
    hideStudyExtras();
    home.classList.add("hidden"); box.classList.remove("hidden");
    state.phase = "prompt"; state.recallMode = "options"; state.hints = []; state.replays = 0; state.startedAt = performance.now();
    if (state.session?.engine === "group") {
      if (task.kind === "meaning_mcq") { box.innerHTML = meaningOptions(task); if (state.settings.autoplay) setTimeout(() => speak(task.word.word, box.querySelector("[data-replay-word]")), 80); }
      else if (task.kind === "know_check") { box.innerHTML = knowCheck(task, false); startKnowTimer(4); if (state.settings.autoplay) setTimeout(() => speak(task.word.word, box.querySelector("[data-replay-word]")), 80); }
      else if (task.kind === "review_self") { box.innerHTML = knowCheck(task, true); startKnowTimer(3); if (state.settings.autoplay) setTimeout(() => speak(task.word.word, box.querySelector("[data-replay-word]")), 80); }
      else { box.innerHTML = spellingPrompt(task); if (state.settings.autoplay) setTimeout(() => speak(task.word.word), 120); }
      return;
    }
    if (task.is_new && !state.introduced.has(task.word.normalized)) box.innerHTML = introHtml(task);
    else if (task.card_type === "meaning") box.innerHTML = meaningOptions(task);
    else { box.innerHTML = spellingPrompt(task); if (state.settings.autoplay) setTimeout(() => speak(task.word.word), 120); }
  }

  function startKnowTimer(seconds) {
    clearKnowTimer();
    state.timerTimeout = setTimeout(() => {
      state.timerTimeout = null;
      submitAttempt("unknown", {timeout: true});
    }, seconds * 1000);
  }

  function beginTest() {
    const task = currentTask(); state.introduced.add(task.word.normalized);
    const box = $("#study-session");
    state.startedAt = performance.now();
    box.innerHTML = task.card_type === "meaning" ? meaningOptions(task) : spellingPrompt(task);
    if (task.card_type === "spelling" && state.settings.autoplay) setTimeout(() => speak(task.word.word), 120);
  }

  function showMeaningOptions(mode) {
    state.recallMode = mode;
    const box = $("#study-session");
    box.innerHTML = meaningOptions(currentTask());
  }

  async function submitAttempt(answer, extra = {}) {
    const task = currentTask(); if (!task || state.submitting) return;
    const box = $("#study-session");
    state.submitting = true;
    clearKnowTimer();
    box.querySelectorAll("button,input").forEach(el => el.disabled = true);
    try {
      const payload = {task_index:state.session.current_index, answer, recall_mode:state.recallMode, hints:state.hints, replays:state.replays, duration_ms:Math.round(performance.now()-state.startedAt), ...extra};
      const data = await api(`/api/study/sessions/${state.session.id}/attempts`, {method:"POST", body:JSON.stringify(payload)});
      const result = data.result; state.results.push({...result, task}); state.session.current_index = result.current_index; state.session.status = result.status;
      if (state.session.engine === "group") {
        state.session.current = result.current;
        state.session.progress = result.progress;
        state.session.phase = result.phase;
        if (result.settle_summary) state.session.settle_summary = result.settle_summary;
        const remembered = result.meaning_done && !result.unfamiliar;
        const label = remembered ? "记住了" : (result.correct && result.meaning_done ? "这组记住了，但中途不熟" : (result.correct ? "对了，还要再连对" : "不熟"));
        const nextCopy = result.status === "complete" ? "查看结果" : (task.kind === "spelling" && !result.correct ? "再拼一次" : "继续");
        const detail = result.show_detail || !result.correct;
        box.innerHTML = `${taskHeader(result.current || task)}${streakLights({streak:result.streak, needed:result.needed})}<article class="study-card result-card ${result.correct ? "correct" : "wrong"}"><p class="eyebrow">${result.timeout ? "来不及，算不熟" : (result.correct ? "回答正确" : "这次没答对")}</p><div class="study-word-head"><h2>${esc(task.word.word)}</h2>${playWordButton(task.word.word)}<p class="phonetic-line">${esc(task.word.pos || "词汇")} · ${esc(task.word.phonetic || "")}</p></div>${detail ? `<p>${esc(task.word.definition)}</p>` : ""}<div class="rating-result"><b>${esc(label)}</b><span>${result.scheduled && result.due ? `下次复习：${new Date(result.due).toLocaleString("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}` : (result.meaning_done ? "还在本组，先拼写" : "还在本组循环")}</span></div><button class="primary" data-next-task>${nextCopy}</button></article>`;
        return;
      }
      const label = result.rating === "Again" ? "需要重学" : result.rating === "Hard" ? "有提示，稍难" : result.rating === "Easy" ? "太简单" : "主动答对";
      box.innerHTML = `${taskHeader(task)}<article class="study-card result-card ${result.correct ? "correct" : "wrong"}"><p class="eyebrow">${result.correct ? "回答正确" : result.close ? "很接近，但仍算错误" : "这次没答对"}</p><h2>${esc(task.word.word)}</h2><p>${esc(task.word.definition)}</p><div class="rating-result"><b>${esc(label)}</b><span>${result.scheduled && result.due ? `下次：${new Date(result.due).toLocaleString("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}` : "自由练习未推迟正式复习"}</span></div>${!result.correct&&task.card_type==="spelling"?`<div class="correction-box"><label>请再输入一次正确拼写<input id="correction-input" autocomplete="off"></label><button class="secondary" data-correct-attempt>确认纠正</button><span id="correction-status"></span></div>`:""}<button class="primary" data-next-task ${!result.correct&&task.card_type==="spelling"?"disabled":""}>${result.status === "complete" ? "查看结果" : "下一题"}</button></article>`;
    } catch (err) { window.VocabAtelier?.toast(err.message); box.querySelectorAll("button,input").forEach(el => el.disabled = false); }
    finally { state.submitting = false; }
  }

  function renderResults() {
    const mode = state.session.mode;
    const box = $("#study-session");
    clearKnowTimer();
    if (state.session.engine === "group") {
      const summary = state.session.settle_summary || {};
      const dues = summary.dues || [];
      const remembered = summary.remembered ?? dues.filter(item => !item.unfamiliar).length;
      const unfamiliar = summary.unfamiliar ?? dues.filter(item => item.unfamiliar).length;
      const weak = dues.filter(item => item.unfamiliar);
      box.innerHTML = `<article class="study-results"><p class="eyebrow">GROUP COMPLETE</p><h2>${mode === "review" ? "这组复习完成了" : "这组新词学完了"}</h2><div class="result-metrics"><div><b>${remembered}</b><span>记住</span></div><div><b>${unfamiliar}</b><span>不熟</span></div><div><b>${state.session.total || 0}</b><span>本组词数</span></div><div><b>${dues.length ? new Date(dues[0].due).toLocaleDateString("zh-CN", {month:"numeric",day:"numeric"}) : "—"}</b><span>下次复习</span></div></div>${weak.length ? `<div class="wrong-words"><small>本组不熟</small>${weak.map(item=>`<button data-lookup-word="${attr(item.word)}">${esc(item.word)}</button>`).join("")}</div>` : `<p class="success-copy">这组都记住了，间隔会拉长一些。</p>`}<button class="primary" data-finish-session>回到今日学习</button></article>`;
      refreshCore({force:true}).catch(()=>{});
      return;
    }
    const total = state.results.length, correct = state.results.filter(x=>x.correct).length;
    const corrected = state.results.filter(x=>x.correct || x.corrected).length;
    const avgDuration = total ? state.results.reduce((sum,x)=>sum+(x.duration_ms||0),0)/total : 0;
    const replayCount = state.results.reduce((sum,x)=>sum+(x.replays||0),0);
    const wrong = state.results.filter(x=>!x.correct);
    box.innerHTML = `<article class="study-results"><p class="eyebrow">SESSION COMPLETE</p><h2>${mode === "review" ? "这一轮学习完成了" : "听写加练完成"}</h2><div class="result-metrics"><div><b>${total ? Math.round(correct/total*100) : 0}%</b><span>首次正确率</span></div><div><b>${total ? Math.round(corrected/total*100) : 0}%</b><span>最终纠正率</span></div><div><b>${avgDuration ? (avgDuration/1000).toFixed(1)+"s" : "—"}</b><span>平均耗时</span></div><div><b>${replayCount}</b><span>重播次数</span></div></div>${wrong.length ? `<div class="wrong-words"><small>本轮错词</small>${wrong.map(x=>`<button data-lookup-word="${attr(x.task.word.word)}">${esc(x.task.word.word)}</button>`).join("")}</div>${mode==="dictation"?`<button class="secondary" data-retry-wrong>只练错词</button>`:""}` : `<p class="success-copy">全部答对，做得很好。</p>`}<button class="primary" data-finish-session>回到今日学习</button></article>`;
    refreshCore({force:true}).catch(()=>{});
  }

  function speak(text, button = null, overrides = {}) {
    const options = {
      lang: overrides.lang || state.settings?.voice_lang || "en-GB",
      provider: overrides.provider || state.settings?.voice_provider || "google",
      voiceName: Object.prototype.hasOwnProperty.call(overrides, "voiceName") ? overrides.voiceName : state.settings?.voice_name || "",
      rate: overrides.rate ?? state.settings?.speech_rate ?? .82,
      button
    };
    if (window.VocabSpeech) return window.VocabSpeech.speak(text, options);
    if (!("speechSynthesis" in window)) return window.VocabAtelier?.toast("当前浏览器不支持系统语音");
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = options.lang; utterance.rate = Number(options.rate) || .82; speechSynthesis.speak(utterance);
  }

  function populateVoiceSelect() {
    const voiceSelect = $("#setting-voice-name");
    if (!voiceSelect || !state.settings) return;
    const lang = $("#setting-voice-lang")?.value || state.settings.voice_lang || "en-GB";
    const selected = voiceSelect.value || state.settings.voice_name || "";
    const voices = window.VocabSpeech?.getEnglishVoices(lang) || (window.speechSynthesis?.getVoices?.() || []).filter(voice => /^en[-_]/i.test(voice.lang));
    const best = window.VocabSpeech?.recommendedVoice(lang);
    voiceSelect.innerHTML = `<option value="">自动选择自然音色${best ? ` · ${esc(best.name)}` : ""}</option>${voices.map((voice,index)=>`<option value="${attr(voice.name)}">${index === 0 ? "推荐 · " : ""}${esc(voice.name)} · ${esc(voice.lang)}</option>`).join("")}`;
    voiceSelect.value = voices.some(voice => voice.name === selected) ? selected : "";
    const active = voiceSelect.value ? voices.find(voice => voice.name === voiceSelect.value) : best;
    const usingGoogle = ($("#setting-voice-provider")?.value || state.settings.voice_provider) !== "system";
    $("#voice-quality-copy").textContent = usingGoogle ? "Google 模式只会发送待播放的单词或短语；不可用时自动改用本机语音。" : active ? `当前离线音色：${active.name}（${active.lang.replace("_", "-")}）` : "系统语音列表正在加载。";
  }

  async function renderDictation() {
    try { await refreshCore(); } catch (err) { error("#study-dictation", err.message); return; }
    if (!state.session && state.dashboard.active_sessions?.dictation) await restoreSession(state.dashboard.active_sessions.dictation);
    if (state.session?.mode === "dictation" && state.session.status === "active") return renderCurrentTask();
    $("#study-home").classList.add("hidden");
    $("#study-session").classList.add("hidden");
    $("#study-paraphrase")?.classList.add("hidden");
    $("#study-dictation").classList.remove("hidden");
    $("#study-dictation").innerHTML = `<div class="dictation-builder"><header class="study-extra-head"><p class="eyebrow">FREE SPELLING</p><button class="text-button" data-close-extra type="button">返回今日学习</button></header><h2>自由听写</h2><p>主线学习里已经包含到期拼写。这里只是额外加练，不会提前改正式复习日。</p><div class="scope-picks"><label><input type="checkbox" name="dict-scope" value="due" checked>到期拼写</label><label><input type="checkbox" name="dict-scope" value="mistakes" checked>历史错词</label><label><input type="checkbox" name="dict-scope" value="saved">生词本</label><label><input type="checkbox" name="dict-scope" value="personal">个人词库</label><label><input type="checkbox" name="dict-scope" value="catalogs" checked>所选词书</label></div><div class="catalog-picks">${state.catalogs.map(c=>`<label><input type="checkbox" name="dict-catalog" value="${attr(c.id)}" ${state.settings.enabled_catalogs.includes(c.id)?"checked":""}><b>${esc(c.name)}</b><span>${c.count.toLocaleString()} 词</span></label>`).join("")}</div><div class="form-grid"><label>话题<select id="dictation-topic"><option value="">全部话题</option>${[...new Set((window.VocabAtelier?.getDataset?.()||[]).map(x=>x.topic).filter(Boolean))].sort().map(x=>`<option>${esc(x)}</option>`).join("")}</select></label><label>题量<select id="dictation-limit">${[10,20,30,50].map(n=>`<option ${n===state.settings.dictation_count?"selected":""}>${n}</option>`).join("")}</select></label></div><button class="primary" data-start-dictation>开始听写</button></div>`;
  }

  function renderSettingsSync() {
    if (!state.settings) return;
    const s = state.settings;
    $("#setting-profile-name").value = s.profile_name || DEFAULT_APPEARANCE.profile_name;
    $("#setting-background-enabled").checked = Boolean(s.background_enabled);
    $("#setting-background-overlay").value = s.background_overlay ?? DEFAULT_APPEARANCE.background_overlay;
    $("#background-overlay-copy").textContent = `${Math.round(Number($("#setting-background-overlay").value)*100)}%`;
    $("#setting-button-color").value = validColor(s.button_color);
    $("#button-color-copy").textContent = validColor(s.button_color).toUpperCase();
    renderAppearancePreviews(s); applyAppearance(s);
    $("#catalog-settings").innerHTML = state.catalogs.map(c=>`<div class="catalog-setting"><label><input type="checkbox" name="enabled-catalog" value="${attr(c.id)}" ${s.enabled_catalogs.includes(c.id)?"checked":""}><span><b>${esc(c.name)}</b><small>${c.count.toLocaleString()} 个学习词${c.hidden_count ? ` · 已过滤 ${c.hidden_count.toLocaleString()} 个基础词` : ""} · ${esc(c.description)}</small></span></label><label class="pause-switch"><input type="checkbox" name="paused-catalog" value="${attr(c.id)}" ${s.paused_catalogs.includes(c.id)?"checked":""}>暂停复习</label></div>`).join("");
    $("#setting-daily-limit").value = s.daily_new_limit; $("#setting-band").value = s.target_band; $("#setting-filter-basic").checked = s.filter_basic_words !== false;
    $("#setting-retention").value = String(s.desired_retention); $("#setting-topics").value = (s.target_topics||[]).join(", "); $("#setting-dictation-count").value = s.dictation_count;
    $("#setting-voice-provider").value = s.voice_provider || "google"; $("#setting-voice-lang").value = s.voice_lang; $("#setting-speech-rate").value = s.speech_rate;
    populateVoiceSelect();
    $("#speech-rate-copy").textContent = `${Number(s.speech_rate).toFixed(2)}×`; $("#setting-autoplay").checked = s.autoplay;
  }

  async function renderSettings() {
    try { await refreshCore(); renderSettingsSync(); }
    catch (err) { $("#data-status").textContent = err.message; $("#data-status").className = "form-status error"; }
  }

  async function saveSettings(group) {
    let payload;
    if (group === "plan") payload = {
      enabled_catalogs:[...document.querySelectorAll('[name="enabled-catalog"]:checked')].map(x=>x.value),
      paused_catalogs:[...document.querySelectorAll('[name="paused-catalog"]:checked')].map(x=>x.value),
      daily_new_limit:Number($("#setting-daily-limit").value), target_band:$("#setting-band").value,
      filter_basic_words:$("#setting-filter-basic").checked,
      desired_retention:Number($("#setting-retention").value), target_topics:$("#setting-topics").value.split(",").map(x=>x.trim()).filter(Boolean)
    };
    else payload = {dictation_count:Number($("#setting-dictation-count").value), voice_provider:$("#setting-voice-provider").value, voice_lang:$("#setting-voice-lang").value, voice_name:$("#setting-voice-name").value, speech_rate:Number($("#setting-speech-rate").value), autoplay:$("#setting-autoplay").checked};
    try { const data = await api("/api/settings", {method:"PATCH",body:JSON.stringify(payload)}); state.settings=data.settings; state.coreRefreshedAt=0; await refreshCore({force:true}); window.VocabAtelier?.toast("设置已保存"); renderSettingsSync(); if (location.hash === "#library") renderRemoteLibrary(true,{force:true}); }
    catch (err) { window.VocabAtelier?.toast(err.message); }
  }

  async function saveProfileSettings() {
    const status=$("#profile-form-status"); const save=$("#save-profile-settings"); save.disabled=true;
    status.textContent="正在保存本机外观…"; status.className="form-status";
    try {
      for (const kind of ["avatar","background"]) {
        if (!state.profileDraft[kind]) continue;
        const uploaded=await api("/api/profile/image",{method:"POST",body:JSON.stringify({kind,data_url:state.profileDraft[kind]})});
        state.settings=uploaded.settings; state.profileDraft[kind]=null;
      }
      const draft=currentAppearanceDraft();
      const data=await api("/api/settings",{method:"PATCH",body:JSON.stringify({profile_name:draft.profile_name,background_enabled:draft.background_enabled,background_overlay:draft.background_overlay,button_color:draft.button_color})});
      state.settings=data.settings; renderSettingsSync(); applyAppearance(state.settings);
      status.textContent="个人资料与主题已保存在本机。"; status.className="form-status success";
      window.VocabAtelier?.toast("个人资料与主题已保存");
    } catch (err) { status.textContent=err.message; status.className="form-status error"; }
    finally { save.disabled=false; }
  }

  async function removeProfileImage(kind) {
    const label=kind === "avatar" ? "头像" : "背景照片";
    if (!confirm(`确定移除${label}吗？原始照片不会被删除。`)) return;
    try {
      state.profileDraft[kind]=null;
      if (Number(state.settings?.[`${kind}_version`]) > 0) {
        const data=await api(`/api/profile/image?kind=${kind}`,{method:"DELETE"}); state.settings=data.settings;
      } else if (kind === "background") state.settings.background_enabled=false;
      renderSettingsSync(); applyAppearance(state.settings); window.VocabAtelier?.toast(`${label}已移除`);
    } catch (err) { window.VocabAtelier?.toast(err.message); }
  }

  function resetAppearanceDraft() {
    $("#setting-background-enabled").checked=false; $("#setting-background-overlay").value=DEFAULT_APPEARANCE.background_overlay;
    $("#setting-button-color").value=DEFAULT_APPEARANCE.button_color; $("#background-overlay-copy").textContent="72%";
    $("#button-color-copy").textContent=DEFAULT_APPEARANCE.button_color.toUpperCase(); applyAppearance(currentAppearanceDraft());
    window.VocabAtelier?.toast("已恢复默认外观预览，点击保存后生效");
  }

  async function exportData() {
    try {
      const data = await api("/api/data/export"); const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
      const link=document.createElement("a"); link.href=URL.createObjectURL(blob); link.download=`vocab-atelier-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href);
      $("#data-status").textContent="备份已导出（不含 API Key）。"; $("#data-status").className="form-status success";
    } catch (err) { $("#data-status").textContent=err.message; $("#data-status").className="form-status error"; }
  }

  async function importData(file) {
    if (!file) return;
    try {
      const payload=JSON.parse(await file.text()); const preview=await api("/api/data/import/preview",{method:"POST",body:JSON.stringify({export:payload})});
      const counts=Object.entries(preview.preview.counts).map(([k,v])=>`${k}: ${v}`).join("，");
      if (!confirm(`检测到有效备份：${counts}。\n\n确定以“合并”方式导入吗？`)) return;
      await api("/api/data/import",{method:"POST",body:JSON.stringify({export:payload,mode:"merge"})});
      $("#data-status").textContent="导入完成。"; $("#data-status").className="form-status success"; await refreshCore({force:true});
    } catch (err) { $("#data-status").textContent=err.message; $("#data-status").className="form-status error"; }
  }

  async function clearScope(scope) {
    const labels={dictation:"听写记录",chats:"全部对话",learning:"全部复习进度"};
    if (!confirm(`确定清除${labels[scope]}吗？此操作无法恢复。`)) return;
    try { await api(`/api/data?scope=${scope}`,{method:"DELETE"}); $("#data-status").textContent=`${labels[scope]}已清除。`; $("#data-status").className="form-status success"; await refreshCore({force:true}); }
    catch (err) { $("#data-status").textContent=err.message; $("#data-status").className="form-status error"; }
  }

  async function renderRemoteLibrary(reset = true, { force = false } = {}) {
    const catalogs = state.settings?.enabled_catalogs?.join(",") || "ielts";
    const topic=$("#topic-filter").value === "all" ? "" : $("#topic-filter").value;
    const band=$("#band-filter").value; const search=$("#library-search").value.trim();
    const key=JSON.stringify({catalogs,topic,band,search});
    if(reset && !force && state.libraryWords.length && state.libraryKey===key && Date.now()-state.libraryRefreshedAt<30_000) return;
    if(state.libraryRefreshPromise && state.libraryKey===key) return state.libraryRefreshPromise;
    if (reset) { state.libraryWords=[]; state.libraryCursor=null; }
    state.libraryKey=key;
    const requestToken=++state.libraryRequestToken;
    const params=new URLSearchParams({catalogs,limit:"50",cursor:String(state.libraryCursor||0)}); if(topic)params.set("topic",topic);if(band&&band!=="0")params.set("band",band);if(search)params.set("search",search);
    const request=(async()=>{try {
      const data=await api(`/api/library?${params}`);
      if(requestToken!==state.libraryRequestToken||key!==state.libraryKey)return;
      state.libraryWords.push(...(data.words||[])); state.libraryCursor=data.next_cursor;
      state.libraryRefreshedAt=Date.now();
      $("#library-count").textContent=`${state.libraryWords.length}${state.libraryCursor?"+":""} 词`;
      $("#library-list").innerHTML=state.libraryWords.map(item=>`<article class="word-row" data-word="${attr(item.word)}"><h3>${esc(item.word)}</h3><p>${esc(item.definition)}</p><small>${esc(item.topic)} · ${(item.catalogs||[]).map(x=>x.toUpperCase()).join(" / ")}</small><span class="state">B${esc(item.band)}</span></article>`).join("")+(state.libraryCursor?`<button class="secondary load-more" data-load-library>加载更多</button>`:"");
    } catch (err) { if (!state.libraryWords.length) error("#library-list",err.message); }})();
    state.libraryRefreshPromise=request;
    try{return await request;}finally{if(state.libraryRefreshPromise===request)state.libraryRefreshPromise=null;}
  }

  function bind() {
    document.addEventListener("click", event => {
      if (event.target.closest("[data-start-review]")) startSession("review");
      if (event.target.closest("[data-start-learn]")) startSession("learn");
      const know=event.target.closest("[data-know-answer]"); if(know) submitAttempt(know.dataset.knowAnswer);
      if (event.target.closest("[data-open-paraphrase]")) openParaphrase();
      if (event.target.closest("[data-open-dictation]")) openDictation();
      if (event.target.closest("[data-close-extra]")) { hideStudyExtras(); history.replaceState(null, "", "#study"); renderStudy(); }
      if (event.target.closest("[data-start-dictation]")) { const catalogs=[...document.querySelectorAll('[name="dict-catalog"]:checked')].map(x=>x.value);const scopes=[...document.querySelectorAll('[name="dict-scope"]:checked')].map(x=>x.value); startSession("dictation",{catalogs,scopes,topic:$("#dictation-topic").value,limit:Number($("#dictation-limit").value)}); }
      if (event.target.closest("[data-begin-test]")) beginTest();
      const recall=event.target.closest("[data-recall]"); if(recall) showMeaningOptions(recall.dataset.recall);
      const meaning=event.target.closest("[data-meaning-answer]"); if(meaning) submitAttempt(meaning.dataset.meaningAnswer,{easy:$("#meaning-easy")?.checked||false});
      const replayWord=event.target.closest("[data-replay-word]"); if(replayWord){state.replays++;speak(replayWord.dataset.replayWord,replayWord);return;}
      const replay=event.target.closest("[data-replay]"); if(replay){const task=currentTask(); if(!task) return; state.replays++;speak(task.word.word,replay);const label=replay.querySelector("span"); if(label) label.textContent=`播放 · ${state.replays+1}`;}
      const hint=event.target.closest("[data-hint]"); if(hint&&!state.hints.includes(hint.dataset.hint)){state.hints.push(hint.dataset.hint);const word=currentTask().word.word;$("#spelling-hint").textContent=state.hints.map(x=>x==="first"?`首字母 ${word[0]}`:`${word.length} 个字符`).join(" · ");}
      if(event.target.closest("[data-skip]")) submitAttempt("",{recall_mode:"skip"});
      if(event.target.closest("[data-next-task]")) renderCurrentTask();
      if(event.target.closest("[data-correct-attempt]")){const input=$("#correction-input");api(`/api/study/sessions/${state.session.id}/attempts`,{method:"POST",body:JSON.stringify({task_index:state.session.current_index-1,answer:input.value,correction:true})}).then(({result})=>{if(result.corrected){state.results[state.results.length-1].corrected=true;$("#correction-status").textContent="已纠正";event.target.disabled=true;$("[data-next-task]").disabled=false;}else $("#correction-status").textContent="还不完全正确";}).catch(err=>window.VocabAtelier?.toast(err.message));}
      if(event.target.closest("[data-retry-wrong]")){const words=state.results.filter(x=>!x.correct).map(x=>x.task.word.word);state.session=null;startSession("dictation",{scopes:[],catalogs:[],words,limit:words.length});}
      if(event.target.closest("[data-finish-session]")){state.session=null;state.results=[];renderStudy();}
      const lookup=event.target.closest("[data-lookup-word]");if(lookup)window.VocabAtelier?.lookup(lookup.dataset.lookupWord);
      if(event.target.closest("[data-load-library]"))renderRemoteLibrary(false);
      const clear=event.target.closest("[data-clear-scope]");if(clear)clearScope(clear.dataset.clearScope);
      const anchor=event.target.closest("[data-settings-anchor]");if(anchor)$("#"+anchor.dataset.settingsAnchor)?.scrollIntoView({behavior:"smooth"});
    });
    document.addEventListener("submit",event=>{if(event.target.id!=="study-spelling-form")return;event.preventDefault();const input=$("#study-spelling-input");if(input.value.trim())submitAttempt(input.value,{easy:$("#spelling-easy")?.checked||false});});
    $("#save-study-settings").addEventListener("click",()=>saveSettings("plan")); $("#save-training-settings").addEventListener("click",()=>saveSettings("training"));
    $("#setting-voice-lang").addEventListener("change",()=>{ $("#setting-voice-name").value=""; populateVoiceSelect(); });
    $("#setting-voice-name").addEventListener("change",populateVoiceSelect);
    $("#setting-voice-provider").addEventListener("change",populateVoiceSelect);
    $("#preview-voice").addEventListener("click",event=>speak("Vocabulary",event.currentTarget,{provider:$("#setting-voice-provider").value,lang:$("#setting-voice-lang").value,voiceName:$("#setting-voice-name").value,rate:Number($("#setting-speech-rate").value)}));
    window.VocabSpeech?.onVoicesChanged(populateVoiceSelect);
    $("#save-profile-settings").addEventListener("click",saveProfileSettings); $("#reset-appearance").addEventListener("click",resetAppearanceDraft);
    $("#remove-avatar").addEventListener("click",()=>removeProfileImage("avatar")); $("#remove-background").addEventListener("click",()=>removeProfileImage("background"));
    $("#setting-avatar-file").addEventListener("change",event=>selectProfileImage("avatar",event.target.files[0]));
    $("#setting-background-file").addEventListener("change",event=>selectProfileImage("background",event.target.files[0]));
    $("#crop-close").addEventListener("click",closeProfileCropper); $("#crop-cancel").addEventListener("click",closeProfileCropper); $("#crop-confirm").addEventListener("click",saveCroppedProfileImage);
    $("#crop-zoom").addEventListener("input",event=>{if(state.crop){state.crop.zoom=Number(event.target.value);drawCrop();}});
    const cropCanvas=$("#crop-canvas");
    cropCanvas.addEventListener("pointerdown",event=>{if(!state.crop)return;state.crop.dragging=true;state.crop.lastX=event.clientX;state.crop.lastY=event.clientY;cropCanvas.setPointerCapture(event.pointerId);});
    cropCanvas.addEventListener("pointermove",event=>{if(!state.crop?.dragging)return;const rect=cropCanvas.getBoundingClientRect();state.crop.offsetX+=(event.clientX-state.crop.lastX)*cropCanvas.width/rect.width;state.crop.offsetY+=(event.clientY-state.crop.lastY)*cropCanvas.height/rect.height;state.crop.lastX=event.clientX;state.crop.lastY=event.clientY;drawCrop();});
    cropCanvas.addEventListener("pointerup",()=>{if(state.crop)state.crop.dragging=false;}); cropCanvas.addEventListener("pointercancel",()=>{if(state.crop)state.crop.dragging=false;});
    document.addEventListener("keydown",event=>{if(event.key==="Escape"&&state.crop)closeProfileCropper();});
    $("#setting-profile-name").addEventListener("input",()=>{renderAppearancePreviews(currentAppearanceDraft());applyAppearance(currentAppearanceDraft());});
    $("#setting-background-enabled").addEventListener("change",()=>applyAppearance(currentAppearanceDraft()));
    $("#setting-background-overlay").addEventListener("input",event=>{$("#background-overlay-copy").textContent=`${Math.round(Number(event.target.value)*100)}%`;applyAppearance(currentAppearanceDraft());});
    $("#setting-button-color").addEventListener("input",event=>{$("#button-color-copy").textContent=event.target.value.toUpperCase();applyAppearance(currentAppearanceDraft());});
    $("#setting-speech-rate").addEventListener("input",event=>$("#speech-rate-copy").textContent=`${Number(event.target.value).toFixed(2)}×`);
    $("#export-data").addEventListener("click",exportData); $("#import-data").addEventListener("change",event=>importData(event.target.files[0]));
    ["#topic-filter","#band-filter"].forEach(selector=>$(selector).addEventListener("change",()=>renderRemoteLibrary(true,{force:true})));
    $("#library-search").addEventListener("input",()=>{clearTimeout(state.libraryTimer);state.libraryTimer=setTimeout(()=>renderRemoteLibrary(true,{force:true}),220);});
  }

  window.VocabStudy={renderStudy,renderReview:renderStudy,renderDictation,openParaphrase,openDictation,renderSettings,renderLibrary:(force=false)=>renderRemoteLibrary(true,{force}),refresh:refreshCore};
  bind();
  refreshCore().then(()=>{renderSettingsSync();renderRemoteLibrary(true);if(["#study","#flashcards","#dictation","#paraphrase"].includes(location.hash))renderStudy();if(location.hash==="#dictation")openDictation();if(location.hash==="#paraphrase")openParaphrase();}).catch(()=>{});
})();
