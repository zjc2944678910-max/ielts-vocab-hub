(() => {
  "use strict";

  const synthesis = window.speechSynthesis;
  const listeners = new Set();
  const defaults = {provider:"google", lang:"en-GB", voiceName:"", rate:.82};
  const noveltyVoice = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|organ|superstar|trinoids|wobble|whisper|zarvox)\b/i;
  const naturalVoiceOrder = [
    /google uk english female/i,
    /microsoft.*natural/i,
    /^daniel\b/i,
    /^samantha\b/i,
    /google uk english male/i,
    /google us english/i
  ];
  let requestId = 0;
  let currentAudio = null;

  function normalizeLang(value) {
    return String(value || "en-GB").replace("_", "-").toLowerCase();
  }

  function scoreVoice(voice, lang, requestedName = "") {
    const wanted = normalizeLang(lang);
    const actual = normalizeLang(voice.lang);
    let score = 0;
    if (requestedName && voice.name === requestedName) score += 100000;
    if (actual === wanted) score += 10000;
    else if (actual.split("-")[0] === wanted.split("-")[0]) score += 3000;
    if (voice.default) score += 120;
    if (voice.localService === false) score += 180;
    const naturalIndex = naturalVoiceOrder.findIndex(pattern => pattern.test(voice.name));
    if (naturalIndex >= 0) score += 2400 - naturalIndex * 120;
    if (/premium|enhanced|neural|natural/i.test(voice.name)) score += 1800;
    if (noveltyVoice.test(voice.name)) score -= 50000;
    return score;
  }

  function rankedEnglishVoices(lang = defaults.lang) {
    if (!synthesis?.getVoices) return [];
    return synthesis.getVoices()
      .filter(voice => /^en[-_]/i.test(voice.lang) && !noveltyVoice.test(voice.name))
      .sort((a, b) => scoreVoice(b, lang) - scoreVoice(a, lang) || a.name.localeCompare(b.name));
  }

  function chooseVoice(lang, requestedName = "") {
    const voices = rankedEnglishVoices(lang);
    return (requestedName && voices.find(voice => voice.name === requestedName)) || voices[0] || null;
  }

  function waitForVoices(timeout = 1200) {
    if (!synthesis?.getVoices || synthesis.getVoices().length) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        synthesis.removeEventListener?.("voiceschanged", done);
        resolve();
      };
      synthesis.addEventListener?.("voiceschanged", done, {once:true});
      timer = setTimeout(done, timeout);
    });
  }

  function notify(message) {
    window.VocabAtelier?.toast?.(message);
  }

  function updateButton(button, state, originalTitle) {
    if (!button) return;
    button.classList.toggle("speaking", state === "speaking");
    button.classList.toggle("audio-error", state === "error");
    button.setAttribute("aria-pressed", state === "speaking" ? "true" : "false");
    button.title = state === "speaking" ? "正在播放" : originalTitle || "播放发音";
  }

  async function speak(text, options = {}) {
    const content = String(text || "").trim();
    if (!content) return false;
    if (!synthesis || typeof window.SpeechSynthesisUtterance !== "function") {
      notify("当前浏览器不支持系统语音，请使用最新版 Chrome 或 Safari。");
      return false;
    }

    const id = ++requestId;
    const button = options.button || null;
    const originalTitle = button?.title || "播放发音";
    currentAudio?.pause();
    currentAudio = null;
    updateButton(button, "loading", originalTitle);
    const provider = options.provider || defaults.provider;
    if (provider === "google") {
      const played = await speakGoogle(content, options, id, button, originalTitle);
      if (played || id !== requestId) return played;
    }
    await waitForVoices();
    if (id !== requestId) return false;

    const lang = options.lang || defaults.lang;
    const voiceName = options.voiceName ?? defaults.voiceName;
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = lang;
    utterance.rate = Math.max(.5, Math.min(1.2, Number(options.rate ?? defaults.rate) || .82));
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.voice = chooseVoice(lang, voiceName);

    synthesis.cancel();
    await new Promise(resolve => setTimeout(resolve, 90));
    if (id !== requestId) return false;

    return new Promise(resolve => {
      let started = false;
      const startTimer = setTimeout(() => {
        if (started || id !== requestId) return;
        synthesis.cancel();
        updateButton(button, "error", originalTitle);
        notify("浏览器没有启动语音。请确认当前标签页未静音，并检查 Chrome 的声音输出设备。");
        resolve(false);
      }, 2600);
      const finish = success => {
        clearTimeout(startTimer);
        if (id === requestId) updateButton(button, success ? "idle" : "error", originalTitle);
        resolve(success);
      };
      utterance.onstart = () => {
        started = true;
        clearTimeout(startTimer);
        updateButton(button, "speaking", originalTitle);
        options.onStart?.(utterance.voice);
      };
      utterance.onend = () => finish(true);
      utterance.onerror = event => {
        if (["canceled", "interrupted"].includes(event.error) && id !== requestId) return resolve(false);
        notify(event.error === "not-allowed" ? "浏览器阻止了声音，请先点击页面后再播放。" : `语音播放失败：${event.error || "浏览器未返回原因"}`);
        finish(false);
      };
      if (synthesis.paused) synthesis.resume();
      synthesis.speak(utterance);
    });
  }

  function speakGoogle(content, options, id, button, originalTitle) {
    return new Promise(resolve => {
      const lang = options.lang || defaults.lang;
      const apiBase = window.VocabRuntime?.apiBase ?? "http://127.0.0.1:8081";
      const audio = new Audio(`${apiBase}/api/pronunciation?text=${encodeURIComponent(content)}&lang=${encodeURIComponent(lang)}`);
      currentAudio = audio;
      audio.preload = "auto";
      audio.playbackRate = Math.max(.75, Math.min(1.2, Number(options.rate ?? defaults.rate) || .82));
      let started = false;
      const finish = success => {
        if (currentAudio === audio) currentAudio = null;
        if (id === requestId) updateButton(button, success ? "idle" : "loading", originalTitle);
        resolve(success);
      };
      audio.onplay = () => {
        started = true;
        updateButton(button, "speaking", originalTitle);
        options.onStart?.({name:"Google Translate", lang});
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
      setTimeout(() => { if (!started && currentAudio === audio) { audio.pause(); finish(false); } }, 3200);
    });
  }

  function configure(options = {}) {
    if (options.provider) defaults.provider = options.provider === "system" ? "system" : "google";
    if (options.lang) defaults.lang = options.lang;
    if (Object.prototype.hasOwnProperty.call(options, "voiceName")) defaults.voiceName = options.voiceName || "";
    if (Number.isFinite(Number(options.rate))) defaults.rate = Number(options.rate);
  }

  synthesis?.addEventListener?.("voiceschanged", () => listeners.forEach(listener => listener()));

  window.VocabSpeech = {
    speak,
    configure,
    getEnglishVoices: rankedEnglishVoices,
    recommendedVoice: (lang, requestedName = "") => chooseVoice(lang, requestedName),
    onVoicesChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
})();
