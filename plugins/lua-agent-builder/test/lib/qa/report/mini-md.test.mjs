import { renderMarkdown, renderInline, escapeHtml } from '../../../../lib/qa/report/mini-md.mjs';

describe('renderInline', () => {
  it('renders code, bold, em and links, and escapes the rest', () => {
    expect(renderInline('a `x < y` **b** *c* [d](https://example.com/p?a=1&b=2)')).toBe(
      'a <code>x &lt; y</code> <strong>b</strong> <em>c</em> <a href="https://example.com/p?a=1&amp;b=2">d</a>',
    );
  });
  it('escapes raw html and drops unsafe link targets', () => {
    expect(renderInline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(renderInline('[click](javascript:alert)')).toBe('click');
    expect(renderInline('[rel](diagrams/a.svg) [anchor](#top) [mail](mailto:a@example.com)')).toContain('<a href="diagrams/a.svg">rel</a>');
  });
  it('handles backslash escapes, escaped pipes and stray control characters', () => {
    expect(renderInline('a\\_b\\*c\\|d \\<b\\>')).toBe('a_b*c|d &lt;b&gt;');
    expect(renderInline('x\uE000y\uE001z')).toBe('xyz');
    expect(renderInline('`a\\|b`')).toBe('<code>a\\|b</code>');
  });
  it('escapeHtml covers quotes', () => {
    expect(escapeHtml('"&<>')).toBe('&quot;&amp;&lt;&gt;');
  });
});

describe('renderMarkdown', () => {
  const md = [
    '## The short version {#short-version}',
    '',
    '<div class="lede">One <b>two</b>',
    '<div>nested</div> end</div>',
    '',
    '<div class="numbers">',
    '<div class="num"><b>1</b><span>x</span></div>',
    '</div>',
    '',
    '### Subsection {#sub}',
    '',
    'First line',
    'second line with `code`.',
    '',
    '- one',
    '- two *em*',
    '  continued',
    '',
    '1. first',
    '2. second',
    '',
    '| A | B |',
    '|---|---|',
    '| `x\\|y` | %%PASS%% |',
    '| 1 | 2 | ',
    '',
    '> a quote',
    '> over two lines',
    '',
    '```js',
    'const a = "<b>";',
    '```',
    '',
    '<figure class="diagram"><img src="diagrams/flow.svg" alt="x"></figure>',
    '',
    '## No explicit id here',
    '## No explicit id here',
  ].join('\n');

  it('renders blocks, shifts headings and passes raw html through', () => {
    const { html } = renderMarkdown(md);
    expect(html).toContain('<h1 id="short-version">The short version</h1>');
    expect(html).toContain('<h2 id="sub">Subsection</h2>');
    expect(html).toContain('<div class="lede">One <b>two</b>\n<div>nested</div> end</div>');
    expect(html).toContain('<div class="numbers">\n<div class="num"><b>1</b><span>x</span></div>\n</div>');
    expect(html).toContain('<p>First line second line with <code>code</code>.</p>');
    expect(html).toContain('<ul>\n<li>one</li>\n<li>two <em>em</em> continued</li>\n</ul>');
    expect(html).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<colgroup>\n<col style="width: 50.0%" />\n<col style="width: 50.0%" />\n</colgroup>');
    expect(html).toContain('<td><code>x\\|y</code></td>');
    expect(html).toContain('<td>%%PASS%%</td>');
    expect(html).toContain('<blockquote>\n<p>a quote over two lines</p>\n</blockquote>');
    expect(html).toContain('<pre><code class="js">const a = &quot;&lt;b&gt;&quot;;\n</code></pre>');
    expect(html).toContain('<figure class="diagram"><img src="diagrams/flow.svg" alt="x"></figure>');
    expect(html).toContain('id="no-explicit-id-here"');
    expect(html).toContain('id="no-explicit-id-here-1"');
  });

  it('builds a nested toc of h1 and h2', () => {
    const { toc } = renderMarkdown(md);
    expect(toc.startsWith('<ul>')).toBe(true);
    expect(toc).toContain('<li><a href="#short-version" id="toc-short-version">The short version</a>\n<ul>\n<li><a href="#sub" id="toc-sub">Subsection</a></li>\n</ul>\n</li>');
    expect(toc.match(/<ul>/g).length).toBe(toc.match(/<\/ul>/g).length);
  });

  it('keeps heading levels when the source has its own h1', () => {
    const { html } = renderMarkdown('# Top\n\n## Next');
    expect(html).toContain('<h1 id="top">Top</h1>');
    expect(html).toContain('<h2 id="next">Next</h2>');
  });

  it('puts an h2 with no preceding h1 under its own list item', () => {
    const orphan = renderMarkdown('### only sub\n\n## another\n');
    expect(orphan.toc).toContain('only sub');
  });

  it('returns an empty toc when there are no headings and escapes stray text', () => {
    expect(renderMarkdown('just <b>text</b>').toc).toBe('');
    expect(renderMarkdown('just <b>text</b>').html).toBe('<p>just &lt;b&gt;text&lt;/b&gt;</p>');
    expect(renderMarkdown('').html).toBe('');
  });

  it('handles windows line endings, trailing hashes and unterminated blocks', () => {
    const { html } = renderMarkdown('## Title ##\r\n\r\n```\r\nopen fence\r\n');
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('open fence');
    expect(renderMarkdown('<div class="x">\nnever closed').html).toContain('never closed');
  });

  it('breaks a paragraph at a following block', () => {
    const { html } = renderMarkdown('text\n- item\n\npara\n> q\n\npara2\n```\ncode\n```\n');
    expect(html).toContain('<p>text</p>');
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<p>para</p>');
  });

  it('weights columns by separator dashes and skips colgroup on a width mismatch', () => {
    expect(renderMarkdown('| a | b |\n|---|---------|\n| 1 | 2 |').html).toContain('width: 25.0%');
    expect(renderMarkdown('| a | b |\n|---|\n| 1 | 2 |').html).not.toContain('colgroup');
  });
  it('treats a table without a separator row as a paragraph', () => {
    expect(renderMarkdown('| a | b |\n| c | d |').html).toContain('<p>');
  });
});
