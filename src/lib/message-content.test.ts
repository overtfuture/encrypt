import { describe, expect, it } from 'vitest';
import { redirectUrl, renderMessage } from './message-content';

describe('URL-only redirect detection', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    [
      '  https://example.com/path?q=1#section\n',
      'https://example.com/path?q=1#section',
    ],
    ['http://example.com:8080/path', 'http://example.com:8080/path'],
  ])('recognizes an entire web URL: %s', (text, expected) => {
    expect(redirectUrl(text)).toBe(expected);
  });

  it.each([
    '',
    'Visit https://example.com',
    'https://example.com more text',
    'https://example.com\nhttps://example.org',
    '[Go](https://example.com)',
    '<https://example.com>',
    'www.example.com',
    '//example.com',
    'mailto:person@example.com',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:password@example.com',
    'https://example.com/line\nbreak',
    'https://example.com/\u0000path',
    'https://',
  ])('does not redirect other content: %s', (text) => {
    expect(redirectUrl(text)).toBeNull();
  });
});

describe('rendered message boundaries', () => {
  it('escapes raw HTML and excludes executable link protocols', () => {
    const html = renderMessage(
      '<img src=x onerror=alert(1)>\n\n[Run](javascript:alert(1))\n\n[Data](data:text/html,test)',
    );
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(?:img|script|iframe|a)\b/);
  });

  it('detects links while keeping code spans as code', () => {
    const html = renderMessage(
      'https://example.com/path and `https://example.org/code`',
    );
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code>https://example.org/code</code>');
    expect(html).not.toContain('href="https://example.org/code"');
  });

  it('renders image references as escaped links without fetching images', () => {
    const html = renderMessage(
      '![<img onerror=alert(1)>](https://example.com/image.png)',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/image.png"');
    expect(html).toContain('Image: &lt;img onerror=alert(1)&gt;');
  });
});
