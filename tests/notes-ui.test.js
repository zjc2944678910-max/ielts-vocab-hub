"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const staticFiles = new Set([
  "/index.html", "/styles.css", "/runtime-config.js", "/startup-redirect.js",
  "/dict.js", "/speech.js", "/app.js", "/markdown.js", "/ai-app.js",
  "/notes-app.js", "/study-app.js", "/speaking-app.js", "/data/ielts-catalog.js",
  "/vendor/katex/katex.min.css", "/vendor/katex/katex.min.js",
  "/assets/graphic-eq-round.svg",
]);
const stamp = "2026-08-14T08:00:00+00:00";
const longContent = Array.from({ length: 150 }, (_, index) => `第 ${index + 1} 行：原因与解决方案`).join("\n");
const notes = new Map([
  ["long", { id:"long", notebook_id:"default-notebook", notebook_name:"我的笔记", title:"长笔记", tags:[], source_filename:"", version:1, created_at:stamp, updated_at:stamp, content_md:longContent }],
  ["second", { id:"second", notebook_id:"default-notebook", notebook_name:"我的笔记", title:"第二篇", tags:[], source_filename:"", version:1, created_at:stamp, updated_at:stamp, content_md:"第二篇内容" }],
]);
for (let index = 0; index < 28; index += 1) {
  const id = `extra-${index}`;
  notes.set(id, { id, notebook_id:"default-notebook", notebook_name:"我的笔记", title:`测试笔记 ${index + 1}`, tags:[], source_filename:"", version:1, created_at:stamp, updated_at:stamp, content_md:`测试内容 ${index + 1}` });
}
const patchPayloads = [];
let createRequests = 0;

const json = (response, body, status = 200) => {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Content-Length":raw.length });
  response.end(raw);
};
const summary = note => ({ ...note, content_md:undefined, excerpt:note.content_md.replace(/\s+/g, " ").slice(0, 180) });
const bodyJson = request => new Promise(resolve => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")));
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && (url.pathname === "/" || staticFiles.has(url.pathname))) {
    const targetPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.join(root, targetPath.slice(1));
    const raw = fs.readFileSync(target);
    const type = target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "application/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html";
    response.writeHead(200, { "Content-Type":`${type}; charset=utf-8`, "Content-Length":raw.length });
    response.end(raw);
    return;
  }
  if (url.pathname === "/health") return json(response, { ok:true, version:2 });
  if (request.method === "GET" && url.pathname === "/api/notebooks") return json(response, { notebooks:[{id:"default-notebook",name:"我的笔记",sort_order:0,note_count:notes.size}], usage:{notes:notes.size,bytes:5000} });
  if (request.method === "GET" && url.pathname === "/api/notes") return json(response, { notes:[...notes.values()].map(summary), usage:{notes:notes.size,bytes:5000} });
  const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
  if (request.method === "GET" && noteMatch) {
    const delay = noteMatch[1] === "long" ? 240 : 60;
    return setTimeout(() => json(response, { note:notes.get(noteMatch[1]) }), delay);
  }
  if (request.method === "PATCH" && noteMatch) {
    const payload = await bodyJson(request);
    patchPayloads.push(payload);
    return setTimeout(() => {
      const current = notes.get(noteMatch[1]);
      const updated = { ...current, ...payload, version:current.version + 1, updated_at:new Date().toISOString() };
      notes.set(noteMatch[1], updated);
      json(response, { note:updated });
    }, 260);
  }
  if (request.method === "POST" && url.pathname === "/api/notes") {
    createRequests += 1;
    await bodyJson(request);
    return setTimeout(() => {
      const existing = [...notes.values()].find(note => note.title === "无标题笔记" && !note.content_md.trim());
      if (existing) return json(response, {note:existing,reused:true});
      const note = { id:"blank", notebook_id:"default-notebook", notebook_name:"我的笔记", title:"无标题笔记", tags:[], source_filename:"", version:1, created_at:stamp, updated_at:stamp, content_md:"" };
      notes.set(note.id, note);
      json(response, {note,reused:false}, 201);
    }, 180);
  }
  if (request.method === "POST" && /^\/api\/notes\/[^/]+\/ai-drafts$/.test(url.pathname)) {
    response.writeHead(200, {"Content-Type":"text/event-stream; charset=utf-8"});
    response.end([
      "event: start\ndata: {\"draft_id\":\"empty-draft\",\"source_version\":1}",
      "event: error\ndata: {\"type\":\"empty_ai_draft\",\"message\":\"模型没有生成可用的笔记正文，请重试或在设置中更换模型\"}",
      "",
    ].join("\n\n"));
    return;
  }
  const generic = {
    "/api/config/status":{configured:false}, "/api/settings":{settings:{}},
    "/api/catalogs":{catalogs:[]}, "/api/study/dashboard":{dashboard:{}},
    "/api/words":{words:[]}, "/api/chats":{chats:[]},
    "/api/account/status":{authenticated:false,identity_mode:"anonymous"},
  };
  if (request.method === "GET" && generic[url.pathname]) return json(response, generic[url.pathname]);
  json(response, {ok:true});
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({headless:true, executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await page.goto(`http://127.0.0.1:${port}/?public=1#notes`);
    await page.locator('[data-note-id="long"]').click();
    await page.waitForFunction(() => document.querySelector("#note-title")?.value === "长笔记");

    const layout = await page.evaluate(() => {
      const shell = document.querySelector(".notes-shell");
      const nav = document.querySelector(".notes-navigator");
      const editor = document.querySelector("#note-content");
      return {
        viewport:innerHeight, documentHeight:document.documentElement.scrollHeight,
        shellBottom:Math.round(shell.getBoundingClientRect().bottom),
        navBottom:Math.round(nav.getBoundingClientRect().bottom),
        editorClient:editor.clientHeight, editorScroll:editor.scrollHeight,
        breaks:document.querySelectorAll("#note-preview br").length,
        view:document.querySelector(".note-workspace").dataset.noteView,
        previewVisible:getComputedStyle(document.querySelector(".note-preview-pane")).display !== "none",
        listClient:document.querySelector("#note-list").clientHeight,
        listScroll:document.querySelector("#note-list").scrollHeight,
      };
    });
    assert.ok(layout.documentHeight <= layout.viewport + 1, JSON.stringify(layout));
    assert.ok(layout.shellBottom <= layout.viewport && layout.navBottom <= layout.viewport, JSON.stringify(layout));
    assert.ok(layout.editorScroll > layout.editorClient, JSON.stringify(layout));
    assert.ok(layout.breaks > 100, JSON.stringify(layout));
    assert.equal(layout.view, "edit");
    assert.equal(layout.previewVisible, false);
    assert.ok(layout.listScroll > layout.listClient, JSON.stringify(layout));

    await page.locator("#note-content").fill("词汇");
    await page.locator("#note-content").selectText();
    await page.locator('[data-note-format="bold"]').click();
    assert.equal(await page.locator("#note-content").inputValue(), "**词汇**");

    await page.locator('[data-note-view="preview"]').click();
    assert.equal(await page.locator(".note-workspace").getAttribute("data-note-view"), "preview");
    assert.equal(await page.locator("#note-preview").getAttribute("contenteditable"), "true");
    await page.locator("#note-preview").evaluate(element => {
      element.innerHTML = "<h2>可视化标题</h2><p>直接编辑 <strong>正文</strong> 和 <a href=\"https://example.com\">链接</a></p><ul><li>要点</li></ul><blockquote><p>引用内容</p></blockquote><div class=\"markdown-table-wrap\"><table><thead><tr><th>列</th><th>值</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table></div>";
      element.dispatchEvent(new InputEvent("input", {bubbles:true,inputType:"insertText",data:"正文"}));
    });
    await page.waitForFunction(() => document.querySelector("#note-save-status")?.textContent === "已保存", null, {timeout:4000});
    assert.equal(patchPayloads.at(-1).content_md, "## 可视化标题\n\n直接编辑 **正文** 和 [链接](https://example.com)\n\n- 要点\n\n> 引用内容\n\n| 列 | 值 |\n| --- | --- |\n| A | B |");

    await page.locator('[data-note-view="split"]').click();
    await page.locator("#note-splitter").press("ArrowRight");
    assert.deepEqual(await page.evaluate(() => ({mode:localStorage.getItem("ielts_note_view_mode"),width:localStorage.getItem("ielts_note_editor_width")})), {mode:"split",width:"55"});

    await page.locator("#note-content").fill("保存中的第一版");
    await page.waitForTimeout(780);
    await page.locator("#note-content").fill("保存请求期间输入的最终版本");
    await page.waitForFunction(() => document.querySelector("#note-save-status")?.textContent === "已保存", null, {timeout:4000});
    assert.ok(patchPayloads.length >= 2, JSON.stringify(patchPayloads));
    assert.equal(patchPayloads.at(-1).content_md, "保存请求期间输入的最终版本");

    await page.locator("#note-content").fill("切换前保存");
    await page.waitForTimeout(300);
    const switchStarted = Date.now();
    await page.locator('[data-note-id="second"]').click();
    await page.waitForFunction(() => document.querySelector("#note-title")?.value === "第二篇", null, {timeout:2500});
    assert.ok(Date.now() - switchStarted < 500);

    assert.equal(await page.locator("#note-ai-menu").getAttribute("class"), "note-menu");
    await page.locator("#note-ai-toggle").click();
    await page.locator('[data-note-ai="organize"]').click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("没有生成可用的笔记正文"));
    assert.equal(await page.locator(".note-diff").count(), 0);

    await Promise.all([page.locator("#new-note").click(), page.locator("#new-note").click()]);
    await page.waitForFunction(() => document.querySelector("#note-title")?.value === "无标题笔记");
    assert.equal(createRequests, 1);

    notes.set("long", {...notes.get("long"), content_md:longContent, version:notes.get("long").version + 1});
    await page.setViewportSize({width:390, height:844});
    await page.reload();
    await page.waitForSelector('[data-note-id="long"]');
    await page.locator('[data-note-id="long"]').click();
    await page.waitForFunction(() => document.querySelector("#note-title")?.value === "长笔记");
    const mobile = await page.evaluate(() => {
      const shell = document.querySelector(".notes-shell");
      const editor = document.querySelector("#note-content");
      return {
        viewport:innerHeight,
        documentHeight:document.documentElement.scrollHeight,
        shellBottom:Math.round(shell.getBoundingClientRect().bottom),
        editorClient:editor.clientHeight,
        editorScroll:editor.scrollHeight,
        editVisible:getComputedStyle(document.querySelector(".note-editor-pane")).display !== "none",
      };
    });
    assert.ok(mobile.documentHeight <= mobile.viewport + 1, JSON.stringify(mobile));
    assert.ok(mobile.shellBottom <= mobile.viewport, JSON.stringify(mobile));
    assert.ok(mobile.editorScroll > mobile.editorClient && mobile.editVisible, JSON.stringify(mobile));
    await page.locator('[data-note-mobile-tab="preview"]').click();
    assert.notEqual(await page.locator(".note-preview-pane").evaluate(element => getComputedStyle(element).display), "none");
    console.log("notes UI browser tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
