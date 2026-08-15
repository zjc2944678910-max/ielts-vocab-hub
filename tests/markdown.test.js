"use strict";

const assert = require("node:assert/strict");
const markdown = require("../markdown.js");

const formatted = markdown.render("## 能力\n\n- **词汇精讲**\n- 使用 `collocation`\n\n[Cambridge](https://dictionary.cambridge.org/)");
assert.match(formatted, /<h3>能力<\/h3>/);
assert.match(formatted, /<ul><li><strong>词汇精讲<\/strong><\/li>/);
assert.match(formatted, /<code>collocation<\/code>/);
assert.match(formatted, /href="https:\/\/dictionary\.cambridge\.org\/"/);
assert.match(markdown.render("例：*“contribute to”* 表示导致"), /<em>“contribute to”<\/em>/);
const comparisons = markdown.render("例如 *“affect / effect”*、*“raise / rise”*，并说明区别。");
assert.match(comparisons, /<em>“affect \/ effect”<\/em>、<em>“raise \/ rise”<\/em>/);

const table = markdown.render("| 词汇 | 含义 |\n| --- | ---: |\n| viable | 可行的 |");
assert.match(table, /<table>/);
assert.match(table, /class="align-right">含义/);

const hostile = markdown.render("<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))\n\n```html\n<script>alert(1)<\/script>");
assert.doesNotMatch(hostile, /<img/);
assert.doesNotMatch(hostile, /href="javascript:/);
assert.doesNotMatch(hostile, /<script>/);
assert.match(hostile, /&lt;script&gt;/);
const remoteImage = markdown.render("![remote](https://example.com/private-note.png)");
assert.doesNotMatch(remoteImage, /<img/);

const softBreaks = markdown.render("原因：reason\n问题：problem\n解决方案：solution", {preserveSoftBreaks: true});
assert.match(softBreaks, /原因：reason<br>问题：problem<br>解决方案：solution/);
assert.doesNotMatch(markdown.render("first\nsecond"), /<br>/);

console.log("markdown renderer tests passed");
