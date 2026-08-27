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

  const ARROW_FALLBACKS = {
    "\\rightarrow": "\u2192", "\\to": "\u2192", "\\leftarrow": "\u2190",
    "\\uparrow": "\u2191", "\\downarrow": "\u2193", "\\leftrightarrow": "\u2194",
    "\\Rightarrow": "\u21d2", "\\Leftarrow": "\u21d0", "\\Leftrightarrow": "\u21d4",
  };

  function fallbackMath(value) {
    let output = String(value || "");
    Object.entries(ARROW_FALLBACKS).forEach(([latex, symbol]) => { output = output.replaceAll(latex, symbol); });
    return escapeHtml(output);
  }

  function renderMath(value, displayMode = false) {
    const source = String(value || "").trim();
    const tag = displayMode ? "div" : "span";
    const className = displayMode ? "math-display" : "math-inline";
    if (!source) return `<${tag} class="${className} math-error"></${tag}>`;
    const engine = typeof globalThis !== "undefined" ? globalThis.katex : null;
    if (!engine?.renderToString) return `<${tag} class="${className} math-error">${fallbackMath(source)}</${tag}>`;
    try {
      const html = engine.renderToString(source, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: "ignore",
      });
      if (/class=["'][^"']*katex-error/.test(html)) throw new Error("invalid math");
      return `<${tag} class="${className}">${html}</${tag}>`;
    } catch {
      return `<${tag} class="${className} math-error">${fallbackMath(source)}</${tag}>`;
    }
  }

  function citationMap(options) {
    const result = new Map();
    for (const source of options?.citations || []) {
      const ref = String(source?.ref || "").trim();
      const noteId = String(source?.note_id || "").trim();
      if (/^N\d+$/.test(ref) && noteId) result.set(ref, source);
    }
    return result;
  }

  function renderInline(value, options = {}) {
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
    source = source.replace(/\\\(([^\n]+?)\\\)/g, (_, math) => keep(renderMath(math, false)));
    source = source.replace(/(^|[^\\$])\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_, prefix, math) => `${prefix}${keep(renderMath(math, false))}`);

    const citations = citationMap(options);
    source = source.replace(/\[(N\d+(?:\s*,\s*N\d+)*)\]/g, (match, group) => {
      const valid = group.split(",").map(ref => ref.trim()).filter(ref => citations.has(ref));
      if (!valid.length) return match;
      return keep(`<span class="inline-citations">${valid.map(ref => {
        const citation = citations.get(ref);
        const title = citation.title ? ` title="${escapeHtml(citation.title)}"` : "";
        return `<button type="button" class="inline-citation" data-open-note="${escapeHtml(citation.note_id)}"${title}>[${escapeHtml(ref)}]</button>`;
      }).join("")}</span>`);
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
      output.push(`<p>${paragraph.map(line => renderInline(line, options)).join(preserveSoftBreaks ? "<br>" : " ")}</p>`);
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

      const trimmed = line.trim();
      const mathBlock = trimmed.startsWith("$$") ? {open:"$$", close:"$$"}
        : trimmed.startsWith("\\[") ? {open:"\\[", close:"\\]"} : null;
      if (mathBlock) {
        flushBlocks();
        let source = trimmed.slice(mathBlock.open.length);
        let closed = source.includes(mathBlock.close);
        if (closed) source = source.slice(0, source.indexOf(mathBlock.close));
        while (!closed && index + 1 < lines.length) {
          index += 1;
          const next = lines[index];
          const closeAt = next.indexOf(mathBlock.close);
          if (closeAt >= 0) {
            source += `${source ? "\n" : ""}${next.slice(0, closeAt)}`;
            closed = true;
          } else source += `${source ? "\n" : ""}${next}`;
        }
        output.push(renderMath(source, true));
        continue;
      }

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
        output.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map((cell, cellIndex) => `<th class="align-${alignments[cellIndex] || "left"}">${renderInline(cell, options)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td class="align-${alignments[cellIndex] || "left"}">${renderInline(row[cellIndex] || "", options)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        flushBlocks();
        const level = Math.min(4, heading[1].length + 1);
        output.push(`<h${level}>${renderInline(heading[2], options)}</h${level}>`);
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        flushBlocks(); output.push("<hr>"); continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushBlocks(); output.push(`<blockquote>${renderInline(quote[1], options)}</blockquote>`); continue;
      }
      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? "ul" : "ol";
        if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
        output.push(`<li>${renderInline((unordered || ordered)[1], options)}</li>`);
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
