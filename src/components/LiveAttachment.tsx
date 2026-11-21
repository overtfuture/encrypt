import { createSignal, onCleanup, Show } from 'solid-js';
import type { LiveFile } from '../lib/identity/live-files';
import { Icon } from './Icon';

export type Attachment = {
  file: LiveFile;
  contact: string;
  direction: 'incoming' | 'outgoing';
  savedAt: number;
};

function photoFormat(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return 'image/png';
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
}

export default function LiveAttachment(props: { file: LiveFile }) {
  const [preview, setPreview] = createSignal<string>();
  const [previewFailed, setPreviewFailed] = createSignal(false);
  const format = photoFormat(props.file.bytes);
  onCleanup(() => {
    const url = preview();
    if (url) URL.revokeObjectURL(url);
  });

  function showPhoto() {
    if (!format) return;
    setPreview(
      URL.createObjectURL(new Blob([props.file.bytes], { type: format })),
    );
  }

  function download() {
    const url = URL.createObjectURL(
      new Blob([props.file.bytes], { type: 'application/octet-stream' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = props.file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const size = props.file.bytes.byteLength;
  return (
    <div class="bubble live-attachment">
      <strong>{props.file.name}</strong>
      <p class="field-help">{size.toLocaleString()} bytes · Download to keep</p>
      <Show when={preview()}>
        {(url) => (
          <Show
            when={!previewFailed()}
            fallback={
              <p>Preview unavailable. You can still download this photo.</p>
            }
          >
            <img
              src={url()}
              alt={props.file.name}
              onError={() => setPreviewFailed(true)}
            />
          </Show>
        )}
      </Show>
      <div class="button-row">
        <Show when={format && !preview()}>
          <button type="button" class="quiet-button" onClick={showPhoto}>
            <Icon name="eye" /> Preview photo
          </button>
        </Show>
        <button
          type="button"
          class="secondary-button"
          aria-label={`Download ${props.file.name}`}
          onClick={download}
        >
          <Icon name="download" /> Download
        </button>
      </div>
    </div>
  );
}
