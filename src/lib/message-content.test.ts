import { describe, expect, it } from 'vitest';
import { renderMessage } from './message-content';

describe('message Markdown', () => {
  it('renders block and inline formatting', () => {
    const html = renderMessage(
      [
        '# Heading',
        '',
        '**Bold**, *italic*, ~~removed~~, and `inline`.',
        '',
        '> A quote',
        '',
        '1. Ordered item',
        '',
        '- Unordered item',
        '',
        '| Key | Value |',
        '| --- | --- |',
        '| Name | Example |',
        '',
        '~~~js',
        'console.log("hello");',
        '~~~',
        '',
        'First line',
        'Second line',
      ].join('\n'),
    );
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<s>removed</s>');
    expect(html).toContain('<code>inline</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<th>Key</th>');
    expect(html).toContain('<td>Example</td>');
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain('First line<br>');
  });

  it('shows read-only task checkboxes while preserving nested formatting', () => {
    const html = renderMessage(
      '- [x] **Done**\n- [ ] Remaining\n  - [X] Nested\n\n\\[x] Plain text',
    );
    expect(html.match(/<input\b[^>]*>/g)).toHaveLength(3);
    expect(html.match(/<input\b[^>]*\bdisabled\b[^>]*>/g)).toHaveLength(3);
    expect(html.match(/<input\b[^>]*\bchecked\b[^>]*>/g)).toHaveLength(2);
    expect(html).toContain('<strong>Done</strong>');
    expect(html).toContain('[x] Plain text');
  });

  it('escapes raw HTML and excludes unsafe links', () => {
    const html = renderMessage(
      '<img src=x onerror=alert(1)>\n\n[Run](java&#x73;cript:alert(1))\n\n[Data](data:text/html,test)\n\n[Other](/relative-link)',
    );
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(?:img|script|iframe|a)\b/);
  });

  it('opens safe links explicitly and leaves inline code inert', () => {
    const html = renderMessage(
      'https://example.com/path and `https://example.org/code`',
    );
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code>https://example.org/code</code>');
    expect(html).not.toContain('href="https://example.org/code"');
  });

  it('turns image references into escaped links without rendering images', () => {
    const html = renderMessage(
      '![<img onerror=alert(1)>](https://example.com/image.png)',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/image.png"');
    expect(html).toContain('Image: &lt;img onerror=alert(1)&gt;');
  });

  it('preserves the destination when an image is used as a link label', () => {
    const html = renderMessage(
      '[![Project preview](https://example.com/preview.png)](https://example.com/project)',
    );
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com/project"');
    expect(html).toContain('>Image: Project preview</a>');
  });
});
