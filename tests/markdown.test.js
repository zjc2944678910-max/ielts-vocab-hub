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

global.katex = {
  renderToString(source, options) {
    assert.equal(options.trust, false);
    assert.equal(options.throwOnError, false);
    if (source.includes("broken")) return '<span class="katex-error">bad</span>';
    return `<span class="katex">${markdown.escapeHtml(source)}</span>`;
  }
};
const math = markdown.render("行内 $a^2 + b^2 = c^2$ 和 \\(x+1\\)。\n\n$$\\frac{1}{2}$$\n\n\\[y = mx + b\\]");
assert.match(math, /class="math-inline"/);
assert.match(math, /class="math-display"/);
assert.match(math, /\\frac\{1\}\{2\}/);
assert.match(markdown.render("`$not_math$`\n\n```js\nconst price = '$5';\n```"), /<code>\$not_math\$<\/code>/);
assert.doesNotMatch(markdown.render("`$not_math$`"), /math-inline/);
assert.match(markdown.render("错误 $broken$，箭头 $\\rightarrow$"), /math-error/);

const cited = markdown.render("参见 [N5] 和 [N8,N9]，忽略 [N404]。", {citations: [
  {ref:"N5", note_id:"note-5", title:"词义"},
  {ref:"N8", note_id:"note-8", title:"写作"},
  {ref:"N9", note_id:"note-9", title:"搭配"},
]});
assert.match(cited, /data-open-note="note-5"/);
assert.match(cited, /data-open-note="note-8"/);
assert.match(cited, /data-open-note="note-9"/);
assert.doesNotMatch(cited, /data-open-note="N404"/);

console.log("markdown renderer tests passed");
