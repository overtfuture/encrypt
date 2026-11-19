import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

markdown.validateLink = (value) => {
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
};

markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  _env,
  renderer,
) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  for (
    let i = index + 1;
    i < tokens.length && tokens[i].type !== 'link_close';
    i++
  ) {
    if (tokens[i].type === 'image')
      tokens[i].meta = { ...tokens[i].meta, linkedImage: true };
  }
  return renderer.renderToken(tokens, index, options);
};

// Image references are opened explicitly so viewing a message cannot fetch them.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const label = markdown.utils.escapeHtml(token.content || 'Open image');
  if (token.meta?.linkedImage) return `Image: ${label}`;
  const href = markdown.utils.escapeHtml(String(token.attrGet('src') ?? ''));
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">Image: ${label}</a>`;
};

markdown.core.ruler.after('inline', 'message_tasks', (state) => {
  const { tokens } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    const item = tokens[i - 2];
    if (
      inline.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      item.type !== 'list_item_open'
    )
      continue;

    const marker = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
    if (!marker) continue;
    const completed = marker[1] !== ' ';
    const checkbox = new state.Token('task_checkbox', 'input', 0);
    checkbox.attrSet('type', 'checkbox');
    checkbox.attrSet('disabled', '');
    if (completed) checkbox.attrSet('checked', '');
    checkbox.attrSet(
      'aria-label',
      completed ? 'Completed task' : 'Incomplete task',
    );
    item.attrJoin('class', 'message-task');

    // Parse the label without the marker so a reference named "x" cannot claim it.
    inline.content = inline.content.slice(marker[0].length);
    const label: typeof tokens = [];
    state.md.inline.parse(inline.content, state.md, state.env, label);
    inline.children = [checkbox, ...label];
  }
});

export function renderMessage(text: string): string {
  return markdown.render(text);
}
