(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SafeMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));

  function safeHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!/^https?:\/\//i.test(raw)) return "";
    try {
      const parsed = new URL(raw);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function renderInline(value) {
    const tokens = [];
    const keep = html => {
      const token = `MDTOKEN${tokens.length}PLACEHOLDER`;
      tokens.push(html);
      return token;
    };
    let source = String(value ?? "");

    source = source.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
    source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const safeHref = safeHttpUrl(href);
      if (!safeHref) return match;
      return keep(`<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    });

    let html = escapeHtml(source);
    html = html
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[\s(（“‘，。！？：；、])\*([^*\n]+)\*(?=$|[\s).,!?:;，。！？：；、）”’])/g, "$1<em>$2</em>")
      .replace(/(^|[\s(（“‘，。！？：；、])_([^_\n]+)_(?=$|[\s).,!?:;，。！？：；、）”’])/g, "$1<em>$2</em>");
    tokens.forEach((tokenHtml, index) => {
      html = html.replaceAll(`MDTOKEN${index}PLACEHOLDER`, tokenHtml);
    });
    return html;
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map(cell => cell.trim());
  }

  function isTableDivider(line) {
    const cells = splitTableRow(line);
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  function tableAlignment(cell) {
    const centered = cell.startsWith(":") && cell.endsWith(":");
    if (centered) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  }

  function render(markdown, options = {}) {
    const preserveSoftBreaks = options?.preserveSoftBreaks === true;
    const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let paragraph = [];
    let listType = "";
    let inFence = false;
    let fenceLanguage = "";
    let codeLines = [];

    const closeList = () => {
      if (!listType) return;
      output.push(`</${listType}>`);
      listType = "";
    };
    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(renderInline).join(preserveSoftBreaks ? "<br>" : " ")}</p>`);
      paragraph = [];
    };
    const flushBlocks = () => { flushParagraph(); closeList(); };
    const renderCode = () => {
      const language = /^[a-z0-9_-]+$/i.test(fenceLanguage) ? ` class="language-${fenceLanguage.toLowerCase()}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = [];
      fenceLanguage = "";
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
      if (inFence) {
        if (fence) { renderCode(); inFence = false; }
        else codeLines.push(line);
        continue;
      }
      if (fence) {
        flushBlocks();
        inFence = true;
        fenceLanguage = fence[1] || "";
        continue;
      }
      if (!line.trim()) { flushBlocks(); continue; }

      if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        flushBlocks();
        const headers = splitTableRow(line);
        const dividers = splitTableRow(lines[index + 1]);
        const alignments = dividers.map(tableAlignment);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        index -= 1;
        output.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell, cellIndex) => `<th class="align-${alignments[cellIndex] || "left"}">${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td class="align-${alignments[cellIndex] || "left"}">${renderInline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        flushBlocks();
        const level = Math.min(4, heading[1].length + 1);
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        flushBlocks(); output.push("<hr>"); continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushBlocks(); output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`); continue;
      }
      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? "ul" : "ol";
        if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
        output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
        continue;
      }
      closeList();
      paragraph.push(line.trim());
    }

    if (inFence) renderCode();
    flushBlocks();
    return output.join("");
  }

  return { render, renderInline, escapeHtml };
});
