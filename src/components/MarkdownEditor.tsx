import { createEffect, createSignal, Show, type JSX } from 'solid-js';
import { renderMessage } from '../lib/message-content';
import { Icon } from './Icon';

export default function MarkdownEditor(props: {
  id: string;
  label: JSX.Element;
  value: string;
  rows: number;
  maxLength: number;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  const [preview, setPreview] = createSignal(false);
  const hasText = () => Boolean(props.value.trim());
  const previewId = `${props.id}-preview`;

  createEffect(() => {
    if (!hasText()) setPreview(false);
  });

  return (
    <div class="markdown-editor">
      <div class="editor-bar">
        <label for={props.id}>{props.label}</label>
        <button
          class="quiet-button editor-toggle"
          type="button"
          aria-controls={previewId}
          aria-expanded={preview()}
          disabled={!hasText()}
          onClick={() => setPreview(!preview())}
        >
          <Show when={!preview()}>
            <Icon name="eye" />
          </Show>
          {preview() ? 'Edit message' : 'Preview Markdown'}
        </button>
      </div>
      <textarea
        id={props.id}
        rows={props.rows}
        maxlength={props.maxLength}
        placeholder={props.placeholder}
        autocomplete="off"
        hidden={preview()}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div id={previewId} hidden={!preview()}>
        <Show when={preview()}>
          <section
            aria-label="Markdown preview"
            class="editor-preview message-markdown"
            tabindex="0"
            innerHTML={renderMessage(props.value)}
          />
        </Show>
      </div>
    </div>
  );
}
