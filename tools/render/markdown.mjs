/* Tiny zero-dependency Markdown → HTML converter + front-matter parser.
   Pure functions only (no Node APIs) so they can also run in a Pages Function.

   Supports: # headings, paragraphs, **bold**, *italic* / _italic_, `code`,
   ```fenced code```, > blockquotes, - / * / 1. lists, [links](url),
   ![images](src =WxH "caption"), --- rules, ==highlight== (placeholder marker),
   and a YouTube shortcode on its own line:  {{youtube https://youtu.be/ID}}
   Raw HTML in the source is escaped (safe by default). */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Allow only safe URL schemes: http(s), mailto, tel, root-relative, relative, #anchors. */
export function safeUrl(url) {
  const u = String(url ?? "").trim();
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return "#"; // javascript:, data:, etc.
  return u;
}

export function youtubeId(url) {
  const m = String(url ?? "").match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Lightweight YouTube embed: a thumbnail link that becomes an iframe on click (see public/js/main.js). */
export function youtubeEmbed(url, title = "Video") {
  const id = youtubeId(url);
  if (!id) return "";
  return `<figure class="yt"><a class="yt__link" href="https://www.youtube.com/watch?v=${id}" data-yt="${id}" target="_blank" rel="noopener">` +
    `<img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" width="480" height="360" loading="lazy" decoding="async">` +
    `<span class="yt__play" aria-hidden="true"></span><span class="sr-only">Play video: ${escapeHtml(title)} (opens YouTube)</span></a></figure>`;
}

function inline(text) {
  // Pull out code spans first so their contents aren't formatted.
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  // images ![alt](src "title")
  // images ![alt](src =1600x900 "title") — size is optional (defaults to 16:9) and reserves space to avoid layout shift
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+=(\d+)x(\d+))?(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, w, h, title) =>
    `<img src="${escapeHtml(safeUrl(unescape(src)))}" alt="${alt}" width="${w || 1600}" height="${h || 900}"${title ? ` title="${title}"` : ""} loading="lazy" decoding="async">`);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
    const url = safeUrl(unescape(href));
    const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${escapeHtml(url)}"${ext}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  s = s.replace(/==([^=]+)==/g, '<mark class="ph">$1</mark>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}
function unescape(s) { return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }

export function markdownToHtml(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|---+\s*$|\*\*\*+\s*$|\{\{youtube\s)/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^```\s*([\w-]*)/))) {
      const lang = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const level = m[1].length;
      const id = m[2].toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
      i++; continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if ((m = line.match(/^\{\{youtube\s+(\S+)\s*\}\}\s*$/))) { out.push(youtubeEmbed(m[1])); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    // standalone image → figure
    if ((m = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+=\d+x\d+)?(?:\s+"([^"]*)")?\)$/))) {
      const cap = m[3] || "";
      out.push(`<figure>${inline(line.trim())}${cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : ""}</figure>`);
      i++; continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
    if (buf.length) out.push(`<p>${inline(buf.join(" "))}</p>`);
    else i++;
  }
  return out.join("\n");
}

/** Strip Markdown to plain text (for excerpts, reading time, RSS fallbacks). */
export function markdownToText(md) {
  return String(md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`=~-]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Parse a simple YAML-ish front-matter block: key: value, quoted strings, true/false, numbers, [a, b] lists. */
export function parseFrontMatter(src) {
  const text = String(src ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const raw of m[1].split("\n")) {
    const line = raw;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    data[kv[1]] = parseValue(kv[2].trim());
  }
  return { data, body: m[2] };
}
function parseValue(v) {
  if (v === "") return "";
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^\d{4}-/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((x) => parseValue(x.trim())).filter((x) => x !== "");
  return v;
}
