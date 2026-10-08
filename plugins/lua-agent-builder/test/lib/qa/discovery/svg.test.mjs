import { describe, test, expect } from '@jest/globals';
import { PALETTE, MARK, SANS, MONO, Svg, escapeXml, wrapText, wrapLines, fit, fmt } from '../../../../lib/qa/discovery/svg.mjs';

describe('escapeXml', () => {
  test('escapes the five XML characters', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;');
  });
  test('null and undefined become empty text', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('fmt and fit', () => {
  test('fmt rounds to one decimal and never prints -0', () => {
    expect(fmt(1.04)).toBe('1');
    expect(fmt(1.26)).toBe('1.3');
    expect(fmt(-0.01)).toBe('0');
  });
  test('fit shortens with an ellipsis and collapses whitespace', () => {
    expect(fit('hello   world', 20)).toBe('hello world');
    expect(fit('abcdefghij', 5)).toBe('abcd…');
    expect(fit('abc', 1)).toBe('a');
    expect(fit(undefined, 5)).toBe('');
  });
});

describe('wrapText and wrapLines', () => {
  test('wraps on words', () => {
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });
  test('hard-breaks a word longer than the width', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('ab abcdefghij', 4)).toEqual(['ab', 'abcd', 'efgh', 'ij']);
  });
  test('empty text gives one empty line', () => {
    expect(wrapText('', 10)).toEqual(['']);
    expect(wrapText(undefined, 10)).toEqual(['']);
  });
  test('wrapLines caps the line count and ellipsises the last line', () => {
    const out = wrapLines('alpha beta gamma delta epsilon zeta', 11, 2);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith('…')).toBe(true);
    expect(wrapLines('short', 20, 3)).toEqual(['short']);
  });
});

describe('Svg', () => {
  test('palette and marker map are the Lua brand values', () => {
    expect(PALETTE.ORANGE).toBe('#ff8a00');
    expect(PALETTE.BLUE).toBe('#0097ff');
    expect(MARK[PALETTE.PINK]).toBe('arrP');
    expect(SANS).toContain('Helvetica');
    expect(MONO).toContain('Menlo');
  });

  test('renders every primitive into one well-formed document', () => {
    const s = new Svg(400, 300, { label: 'A <b> label' });
    s.text(10, 20, 'a < b & c', { mono: true, weight: '700', anchor: 'middle', spacing: 2 });
    s.lines(10, 40, ['one', 'two'], { lh: 12 });
    s.node(10, 60, 100, 40, 'Title', ['sub'], { accent: PALETTE.ORANGE, dashed: true });
    s.node(120, 60, 100, 40, 'Plain', [], { stroke: PALETTE.RED });
    s.arrow(0, 0, 10, 10, { color: PALETTE.BLUE });
    s.path([[0, 0], [5, 5], [9, 0]], { color: '#123456', dashed: true });
    s.path([[0, 0], [1, 1]], { marker: 'arrV' });
    s.line(0, 0, 5, 5, { dashed: true });
    s.line(0, 0, 5, 5);
    s.polyline([[0, 0], [1, 2], [3, 4]], { dashed: true });
    s.polyline([[0, 0], [1, 2]]);
    s.diamond(50, 50, 80, 40, 'one line');
    s.diamond(50, 150, 80, 40, ['two', 'lines']);
    s.pill(100, 100, ['label']);
    s.rect(1, 2, 3, 4, { opacity: 0.5 });
    s.circle(5, 5, 2);
    s.raw('<g/>');
    const out = s.toString();
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"')).toBe(true);
    expect(out.endsWith('</svg>')).toBe(true);
    expect(out).toContain('a &lt; b &amp; c');
    expect(out).toContain('aria-label="A &lt;b&gt; label"');
    expect(out).toContain('marker-end="url(#arrB)"');
    expect(out).toContain('marker-end="url(#arr)"');
    expect(out).toContain('marker-end="url(#arrV)"');
    expect(out).toContain('<polygon');
    expect(out).toContain('opacity="0.5"');
    expect(out).not.toContain('<b>');
    expect(out).toContain('style="max-width:400px"');
    expect(s.render()).toBe(out);
    expect(new Svg(3000, 10).toString()).toContain('max-width:1200px');
  });

  test('background can be switched off and output is deterministic', () => {
    const a = new Svg(10, 10, { background: false }).toString();
    expect(a).not.toContain('rx="14"');
    const mk = () => {
      const s = new Svg(100, 100);
      s.node(1, 2, 3, 4, 't', ['s']);
      return s.toString();
    };
    expect(mk()).toBe(mk());
  });
});
