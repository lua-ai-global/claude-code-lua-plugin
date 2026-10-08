// SVG primitives for the /lua-qa discovery diagrams.
// Same palette, type stacks and node/arrow shapes as the report's guide diagrams, as pure string generation.
// Output is deterministic: no random ids, numbers rounded to one decimal.

export const PALETTE = Object.freeze({
  ORANGE: '#ff8a00',
  PINK: '#f633a2',
  VIOLET: '#995ff8',
  BLUE: '#0097ff',
  INK: '#0a0a0b',
  DIM: '#62626f',
  LINE: '#d9d9df',
  PANEL: '#f6f6f8',
  CARD: '#ffffff',
  BAND: '#eeeef2',
  GREEN: '#166534',
  AMBER: '#92400e',
  RED: '#991b1b',
});

export const SANS = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const { ORANGE, PINK, VIOLET, BLUE, INK, DIM, LINE, PANEL, CARD } = PALETTE;
const MAX_WIDTH = 1200;

/** Arrow-head marker id per stroke colour; any other colour falls back to the grey head. */
export const MARK = Object.freeze({ [ORANGE]: 'arrO', [PINK]: 'arrP', [VIOLET]: 'arrV', [BLUE]: 'arrB', [DIM]: 'arr' });

/** Escape text for use in XML text nodes and attribute values. */
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Number formatting for coordinates: one decimal at most, no trailing zero, no "-0". */
export function fmt(n) {
  const v = Math.round(Number(n) * 10) / 10;
  return String(Object.is(v, -0) ? 0 : v);
}

/** Shorten to at most `max` characters, ending with an ellipsis when cut. */
export function fit(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max < 2) return t.slice(0, Math.max(max, 0));
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Word-wrap to lines of at most `maxChars`; over-long words are hard-broken. Always returns at least one line. */
export function wrapText(s, maxChars) {
  const width = Math.max(1, Math.floor(maxChars));
  const words = String(s ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (let word of words) {
    while (word.length > width) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Wrap and cap: at most `maxLines` lines, the last one ellipsised when text was cut. */
export function wrapLines(s, maxChars, maxLines) {
  const lines = wrapText(s, maxChars);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxChars);
  return kept;
}

export class Svg {
  /**
   * @param {number} w natural width
   * @param {number} h natural height
   * @param {{ label?: string, background?: boolean }} [opts] label becomes the aria-label
   */
  constructor(w, h, { label = 'Diagram', background = true } = {}) {
    this.w = w;
    this.h = h;
    this.label = label;
    this.parts = [];
    if (background) {
      this.parts.push(`<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" rx="14" fill="${PANEL}" stroke="${LINE}"/>`);
    }
  }

  /** The marker definitions (one per palette accent). */
  defs() {
    const m = [['arr', DIM], ['arrO', ORANGE], ['arrP', PINK], ['arrV', VIOLET], ['arrB', BLUE]]
      .map(([id, c]) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`)
      .join('');
    return `<defs>${m}</defs>`;
  }

  raw(s) {
    this.parts.push(s);
  }

  rect(x, y, w, h, { fill = CARD, stroke = LINE, rx = 9, width = 1, dashed = false, opacity } = {}) {
    const dash = dashed ? ' stroke-dasharray="6 4"' : '';
    const op = opacity === undefined ? '' : ` opacity="${opacity}"`;
    this.parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(rx)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash}${op}/>`);
  }

  circle(cx, cy, r, { fill = DIM, stroke = 'none' } = {}) {
    this.parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${fill}" stroke="${stroke}"/>`);
  }

  text(x, y, s, { size = 12, color = INK, weight = 'normal', anchor = 'start', mono = false, spacing = 0 } = {}) {
    const fam = mono ? MONO : SANS;
    this.parts.push(`<text x="${fmt(x)}" y="${fmt(y)}" font-family="${escapeXml(fam)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" letter-spacing="${spacing}">${escapeXml(s)}</text>`);
  }

  lines(x, y, rows, { size = 11.5, color = INK, anchor = 'start', lh = 15, mono = false, weight = 'normal' } = {}) {
    rows.forEach((r, i) => this.text(x, y + i * lh, r, { size, color, weight, anchor, mono }));
  }

  /** A card with an optional accent bar, a bold title and grey sub-lines. */
  node(x, y, w, h, title, sub = [], { accent = null, fill = CARD, titleSize = 12.5, dashed = false, stroke = null } = {}) {
    const line = stroke || accent || LINE;
    const dash = dashed ? ' stroke-dasharray="6 4"' : '';
    this.parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="9" fill="${fill}" stroke="${line}" stroke-width="${accent || stroke ? 1.6 : 1}"${dash}/>`);
    if (accent) this.parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="5" height="${fmt(h)}" rx="2.5" fill="${accent}"/>`);
    const ty = y + 19;
    this.text(x + 14, ty, title, { size: titleSize, color: INK, weight: '600' });
    this.lines(x + 14, ty + 16, sub, { size: 10.5, color: DIM, lh: 13.5 });
  }

  arrow(x1, y1, x2, y2, opts = {}) {
    this.path([[x1, y1], [x2, y2]], opts);
  }

  /** Poly-line with an arrow head at the end. */
  path(pts, { color = DIM, marker = null, dashed = false, width = 1.4 } = {}) {
    const mk = marker || MARK[color] || 'arr';
    const dash = dashed ? ' stroke-dasharray="5 4"' : '';
    const d = `M${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')}`;
    this.parts.push(`<path d="${d}" stroke="${color}" stroke-width="${width}" fill="none" marker-end="url(#${mk})"${dash}/>`);
  }

  /** Plain line (no head). `pts` may be several points. */
  line(x1, y1, x2, y2, { color = DIM, width = 1, dashed = false } = {}) {
    const dash = dashed ? ' stroke-dasharray="3 3"' : '';
    this.parts.push(`<path d="M${fmt(x1)},${fmt(y1)} L${fmt(x2)},${fmt(y2)}" stroke="${color}" stroke-width="${width}" fill="none"${dash}/>`);
  }

  polyline(pts, { color = DIM, width = 1.2, dashed = false } = {}) {
    const dash = dashed ? ' stroke-dasharray="3 3"' : '';
    const d = `M${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')}`;
    this.parts.push(`<path d="${d}" stroke="${color}" stroke-width="${width}" fill="none"${dash}/>`);
  }

  /** A decision diamond; `label` is an array of lines (or one string). */
  diamond(cx, cy, w, h, label, { accent = DIM, fill = CARD, size = 10.5 } = {}) {
    const pts = [[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]].map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
    this.parts.push(`<polygon points="${pts}" fill="${fill}" stroke="${accent}" stroke-width="1.6"/>`);
    const rows = Array.isArray(label) ? label : [label];
    const lh = size + 2.5;
    const y0 = cy - ((rows.length - 1) * lh) / 2 + size / 3;
    rows.forEach((r, i) => this.text(cx, y0 + i * lh, r, { size, color: INK, weight: '600', anchor: 'middle' }));
  }

  /** Small rounded label sitting on a line (predicate text on an edge). */
  pill(cx, cy, rows, { size = 9.5, color = DIM, fill = PANEL, stroke = LINE } = {}) {
    const lh = size + 2;
    const longest = Math.max(...rows.map((r) => r.length));
    const w = longest * size * 0.56 + 14;
    const h = rows.length * lh + 6;
    this.rect(cx - w / 2, cy - h / 2, w, h, { fill, stroke, rx: 8 });
    const y0 = cy - ((rows.length - 1) * lh) / 2 + size / 3;
    rows.forEach((r, i) => this.text(cx, y0 + i * lh, r, { size, color, anchor: 'middle' }));
  }

  toString() {
    const body = this.parts.join('');
    // width 100% with a 1200 px cap: anything wider than that scales down through the viewBox
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(this.w)} ${fmt(this.h)}" width="100%" style="max-width:${fmt(Math.min(this.w, MAX_WIDTH))}px" role="img" aria-label="${escapeXml(this.label)}" font-family="${escapeXml(SANS)}">${this.defs()}${body}</svg>`;
  }

  render() {
    return this.toString();
  }
}
