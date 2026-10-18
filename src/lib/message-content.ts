import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

function allowedLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:', 'mailto:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

markdown.validateLink = allowedLink;
markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  _env,
  renderer,
) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Opening a message must not fetch remote images or tracking pixels.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const href = markdown.utils.escapeHtml(String(token.attrGet('src') ?? ''));
  const label = markdown.utils.escapeHtml(token.content || 'Open image');
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">Image: ${label}</a>`;
};

export function renderMessage(text: string): string {
  return markdown.render(text);
}

export function redirectUrl(text: string): string | null {
  const value = text.trim();
  if (
    !/^https?:\/\//i.test(value) ||
    /[\s\u0000-\u001f\u007f]/.test(value) ||
    !allowedLink(value)
  )
    return null;
  return new URL(value).href;
}
