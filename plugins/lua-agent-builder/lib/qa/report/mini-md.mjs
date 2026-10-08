// Minimal markdown → HTML renderer: the fallback when pandoc is missing.
//
// It supports exactly what sections.mjs emits: ATX headings with {#id}, paragraphs, one-level
// "-" and "1." lists, pipe tables, fenced code, blockquotes, raw-HTML block passthrough
// (<div …> and <figure …>), and inline code, **bold**, *em*, [text](url). Everything else is escaped.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(text) {
  const s = text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}_\- .]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return s || 'section';
}

function safeUrl(url) {
  const u = url.trim();
  if (/^(https?:|mailto:|#|[./]|[A-Za-z0-9_-]+\/|[A-Za-z0-9_-]+\.[A-Za-z0-9]+$)/.test(u) && !/^\s*(javascript|data|vbscript):/i.test(u)) return u;
  return null;
}

/** Inline rendering: escapes first, then code spans, escapes, links, bold and em. */
export function renderInline(text) {
  const stash = [];
  const hold = (html) => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };
  let s = String(text).replace(/[\uE000\uE001]/g, '');
  // code spans (protect first)
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
  // backslash escapes
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>%&~"'$^=:@/])/g, (_, ch) => hold(escapeHtml(ch)));
  s = escapeHtml(s);
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const decoded = url.replace(/&amp;/g, '&');
    const ok = safeUrl(decoded);
    return ok ? hold(`<a href="${escapeHtml(ok)}">${label}</a>`) : label;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  // restore (repeat: links hold labels that may contain stash markers)
  for (let i = 0; i < 3; i++) s = s.replace(/\uE000(\d+)\uE001/g, (_, n) => stash[Number(n)]);
  return s;
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

function countTag(line, tag) {
  const open = (line.match(new RegExp(`<${tag}(?=[\\s>])`, 'g')) ?? []).length;
  const close = (line.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  return open - close;
}

/**
 * @param {string} md
 * @returns {{html:string, toc:string}} body HTML and a nested <ul> table of contents (h1/h2 after a −1 heading shift)
 */
export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const usedIds = new Map();
  let i = 0;

  const uniqueId = (base) => {
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  // No top-level "# " heading in the sources, so every heading moves up one level (## → h1).
  const hasH1 = lines.some((l) => /^# /.test(l));
  const shift = hasH1 ? 0 : 1;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    const fence = /^```\s*([\w-]*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] ? ` class="${escapeHtml(fence[1])}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }
    // raw HTML blocks
    const raw = /^<(div|figure|nav)(?=[\s>])/.exec(line);
    if (raw) {
      const tag = raw[1];
      const block = [];
      let depth = 0;
      do {
        block.push(lines[i]);
        depth += countTag(lines[i], tag);
        i++;
      } while (depth > 0 && i < lines.length);
      out.push(block.join('\n'));
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*?)(?:\s+\{#([A-Za-z0-9_:.-]+)\})?\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.max(1, Math.min(6, h[1].length - shift));
      const inner = renderInline(h[2]);
      const id = uniqueId(h[3] ?? slugify(h[2]));
      headings.push({ level, id, html: inner });
      out.push(`<h${level} id="${escapeHtml(id)}">${inner}</h${level}>`);
      i++;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = splitRow(line);
      // relative column widths from the dash counts of the separator row, as pandoc does
      const dashes = splitRow(lines[i + 1]).map((c) => (c.match(/-/g) ?? []).length);
      const total = dashes.reduce((a, b) => a + b, 0);
      const colgroup = total > 0 && dashes.length === head.length
        ? `<colgroup>\n${dashes.map((d) => `<col style="width: ${((d / total) * 100).toFixed(1)}%" />`).join('\n')}\n</colgroup>\n`
        : '';
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const thead = `<thead>\n<tr>\n${head.map((c) => `<th>${renderInline(c)}</th>`).join('\n')}\n</tr>\n</thead>`;
      const tbody = rows.map((r) => `<tr>\n${r.map((c) => `<td>${renderInline(c)}</td>`).join('\n')}\n</tr>`).join('\n');
      out.push(`<table>\n${colgroup}${thead}\n<tbody>\n${tbody}\n</tbody>\n</table>`);
      continue;
    }
    // blockquote
    if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>\n<p>${renderInline(body.join(' ').trim())}</p>\n</blockquote>`);
      continue;
    }
    // lists
    const ul = /^\s*[-*]\s+/.test(line);
    const ol = /^\s*\d+\.\s+/.test(line);
    if (ul || ol) {
      const items = [];
      const re = ul ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])[1];
        i++;
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li>${renderInline(item)}</li>`);
      }
      out.push(`<${ul ? 'ul' : 'ol'}>\n${items.join('\n')}\n</${ul ? 'ul' : 'ol'}>`);
      continue;
    }
    // paragraph
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|<(div|figure|nav)(\s|>))/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1]))
    ) {
      para.push(lines[i++].trim());
    }
    if (!para.length) {
      // a line that matched no block rule and was not consumed; emit it escaped and move on
      out.push(`<p>${renderInline(lines[i++])}</p>`);
      continue;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc: buildToc(headings) };
}

function buildToc(headings) {
  const items = headings.filter((h) => h.level <= 2);
  if (!items.length) return '';
  const lines = ['<ul>'];
  let open = false;
  let sub = false;
  for (const h of items) {
    const link = `<a href="#${escapeHtml(h.id)}" id="toc-${escapeHtml(h.id)}">${h.html}</a>`;
    if (h.level === 1) {
      if (sub) {
        lines.push('</ul>');
        sub = false;
      }
      if (open) lines.push('</li>');
      lines.push(`<li>${link}`);
      open = true;
    } else {
      if (!open) {
        lines.push('<li>');
        open = true;
      }
      if (!sub) {
        lines.push('<ul>');
        sub = true;
      }
      lines.push(`<li>${link}</li>`);
    }
  }
  if (sub) lines.push('</ul>');
  if (open) lines.push('</li>');
  lines.push('</ul>');
  return lines.join('\n');
}
