(() => {
  "use strict";

  const localHosts = new Set(["127.0.0.1", "localhost", "::1", ""]);
  const publicMode = new URLSearchParams(window.location.search).get("public") === "1" || window.location.port === "8090" || !localHosts.has(window.location.hostname);
  window.VocabRuntime = Object.freeze({
    apiBase: publicMode ? "" : "http://127.0.0.1:8081",
    publicMode,
  });

  if (publicMode) {
    document.documentElement.dataset.publicMode = "true";
    document.addEventListener("DOMContentLoaded", () => {
      const note = document.querySelector("#dictionary-source-note");
      if (note) note.textContent = "每位访客拥有独立词库、对话与 API 配置；智能判断优先查词典，AI 使用你自己的额度。";
      const apiHelp = document.querySelector("#settings-api > p:not(.eyebrow)");
      if (apiHelp) apiHelp.textContent = "密钥只保存到你的独立访客空间，页面和接口不会读取或显示完整密钥。";
    });
  }
})();
