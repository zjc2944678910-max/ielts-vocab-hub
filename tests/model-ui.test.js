"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "output", "playwright");
fs.mkdirSync(output, {recursive:true});

const json = (response, body, status = 200) => {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Content-Length":raw.length});
  response.end(raw);
};

const models = [
  {id:"nvidia/nemotron-3-super-120b-a12b:free",name:"Nemotron Super",task_profiles:["word_enrichment","vocabulary_qa","study_qa","note_tutor"],available:true,status:"available",recommended:true},
  {id:"google/gemma-4-31b-it:free",name:"Gemma 4 31B",task_profiles:["vocabulary_qa","ielts_writing","study_qa"],available:true,status:"available",recommended:true},
];
let chatMessageReads = 0;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && (url.pathname === "/" || !url.pathname.startsWith("/api/") && url.pathname !== "/health")) {
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const target = path.resolve(root, relative);
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return json(response, {error:"not found"}, 404);
    const raw = fs.readFileSync(target);
    const type = target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "application/javascript" : target.endsWith(".woff2") ? "font/woff2" : target.endsWith(".svg") ? "image/svg+xml" : "text/html";
    response.writeHead(200, {"Content-Type":type,"Content-Length":raw.length});
    response.end(raw);
    return;
  }
  if (url.pathname === "/health") return json(response, {ok:true,version:4});
  if (request.method === "GET" && url.pathname === "/api/config/status") return json(response, {
    configured:true, model:"OpenRouter 免费智能分流", routing_mode:"smart_free", default_mode:"smart_free", default_model:"",
    openrouter_configured:true, fallback_configured:true, deepseek_configured:true, manual_model:"deepseek-chat", free_catalog_checked_at:"2026-08-16T10:00:00+00:00",
  });
  if (request.method === "GET" && url.pathname === "/api/models") return json(response, {models,available:true,checked_at:"2026-08-16T10:00:00+00:00"});
  if (request.method === "GET" && url.pathname === "/api/chats") return json(response, {chats:[{id:"chat",title:"公式与引用",current_context:null,created_at:"2026-08-16T10:00:00+00:00",updated_at:"2026-08-16T10:00:00+00:00"}]});
  if (request.method === "GET" && url.pathname === "/api/chats/chat/messages") {
    chatMessageReads += 1;
    if (chatMessageReads === 1) return json(response, {messages:[
      {id:"user",role:"user",content:"解释勾股定理并引用笔记",status:"complete",actions:[],citations:[]},
      {id:"assistant",role:"assistant",content:"",status:"generating",actions:[],citations:[]},
    ],notes:[]});
    return json(response, {messages:[
      {id:"user",role:"user",content:"解释勾股定理并引用笔记",status:"complete",actions:[],citations:[]},
      {id:"assistant",role:"assistant",content:"行内公式 $a^2 + b^2 = c^2$，方向用 $\\rightarrow$。\n\n$$\\frac{a}{b} = c$$\n\n参见 [N5] 与 [N8,N9]。",status:"complete",actions:[],citations:[
        {ref:"N5",note_id:"note-5",title:"勾股定理"},{ref:"N8",note_id:"note-8",title:"公式"},{ref:"N9",note_id:"note-9",title:"例题"},
      ],routing:{source:"free_model",selection_mode:"smart_free",task_profile:"study_qa",requested_model:"nvidia/nemotron-3-super-120b-a12b:free",actual_model:"nvidia/nemotron-3-super-120b-a12b:free"}},
    ],notes:[]});
  }
  const generic = {
    "/api/account/status":{authenticated:false,identity_mode:"anonymous"}, "/api/words":{words:[]},
    "/api/settings":{settings:{voice_provider:"google",voice_lang:"en-GB",voice_name:"",speech_rate:.82,enabled_catalogs:["ielts"],paused_catalogs:[],filter_basic_words:true}},
    "/api/catalogs":{catalogs:[],enabled:["ielts"],paused:[]}, "/api/study/dashboard":{reviewed_today:2,new_words_today:1,due_total:4,new_limit:10,streak:3}, "/api/notebooks":{notebooks:[],usage:{notes:0,bytes:0}},
    "/api/notes":{notes:[],usage:{notes:0,bytes:0}},
  };
  if (request.method === "GET" && generic[url.pathname]) return json(response, generic[url.pathname]);
  json(response, {ok:true});
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  try {
    const assistantUrl = `http://127.0.0.1:${server.address().port}/?public=1#assistant`;
    await page.goto(assistantUrl);
    await page.waitForSelector('.message.assistant .katex');
    await page.waitForFunction(() => document.querySelectorAll('#chat-model-select option').length >= 5);
    assert.ok(chatMessageReads >= 2, `expected chat reconciliation read, got ${chatMessageReads}`);
    assert.equal(await page.locator('.message-loading').count(), 0);
    assert.equal(await page.locator('.inline-citation').count(), 3);
    assert.equal(await page.locator('.math-display .katex-display').count(), 1);
    assert.match(await page.locator('.message-route').textContent(), /智能免费.*学习问答.*nemotron/i);
    await page.locator('#chat-model-select').selectOption('fixed_free:google/gemma-4-31b-it:free');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('ielts_chat_model_selection_v1'))).chat.model, 'google/gemma-4-31b-it:free');
    await page.screenshot({path:path.join(output,"model-routing-desktop.png"),fullPage:true});

    await page.locator('[data-tab="settings"]').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#api-default-model option[value="deepseek"]')));
    assert.equal(await page.locator('#api-default-model option').count(), 4);
    await page.screenshot({path:path.join(output,"model-settings-desktop.png"),fullPage:true});

    await page.setViewportSize({width:390,height:844});
    await page.goto(assistantUrl);
    await page.waitForSelector('.message.assistant .katex');
    assert.equal(await page.locator('#chat-model-select').inputValue(), 'fixed_free:google/gemma-4-31b-it:free');
    await page.waitForTimeout(500);
    const mobile = await page.evaluate(() => ({width:document.documentElement.scrollWidth,viewport:innerWidth,select:document.querySelector('#chat-model-select').getBoundingClientRect().width,sidebarRight:Math.round(document.querySelector('.sidebar').getBoundingClientRect().right)}));
    assert.ok(mobile.width <= mobile.viewport + 1, JSON.stringify(mobile));
    assert.ok(mobile.select >= 140, JSON.stringify(mobile));
    assert.ok(mobile.sidebarRight <= 1, JSON.stringify(mobile));
    await page.screenshot({path:path.join(output,"model-routing-mobile.png"),fullPage:true});
    console.log("model routing UI browser tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
