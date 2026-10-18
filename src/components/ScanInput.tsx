import { createSignal, onCleanup, Show } from 'solid-js';
import QrScanner from 'qr-scanner';
import { Icon } from './Icon';

export default function ScanInput(props: { onRead: (value: string) => void }) {
  const [cameraOpen, setCameraOpen] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal('');
  let video: HTMLVideoElement | undefined;
  let scanner: QrScanner | undefined;
  let alive = true;

  function stop() {
    scanner?.destroy();
    scanner = undefined;
    setCameraOpen(false);
    setStarting(false);
  }
  onCleanup(() => {
    alive = false;
    scanner?.destroy();
  });

  async function start() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'Camera access needs HTTPS or localhost. You can upload a QR image or paste a link instead.',
      );
      return;
    }
    setCameraOpen(true);
    setStarting(true);
    const current: QrScanner = new QrScanner(
      video!,
      (result) => {
        // A worker can finish a decode even after its scanner was destroyed.
        if (!alive || scanner !== current) return;
        stop();
        props.onRead(result.data);
      },
      {
        preferredCamera: 'environment',
        highlightScanRegion: true,
        highlightCodeOutline: true,
      },
    );
    scanner = current;
    try {
      await current.start();
      if (!alive || scanner !== current) current.destroy();
    } catch {
      if (alive && scanner === current) {
        stop();
        setError(
          'Could not access a camera. Check camera permissions, upload a QR image, or paste the link.',
        );
      }
    } finally {
      if (alive) setStarting(false);
    }
  }

  async function upload(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setError('');
    if (file.size > 15_000_000) {
      setError('Choose a QR image smaller than 15 MB.');
      return;
    }
    try {
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      if (alive) props.onRead(result.data);
    } catch {
      if (alive)
        setError(
          'No QR code found. Try a clearer image with the entire QR visible.',
        );
    }
  }

  return (
    <div class="scanner-input">
      <div class="divider-label">
        <span>or scan a QR code</span>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <button
          class="secondary-button"
          type="button"
          onClick={start}
          disabled={cameraOpen()}
        >
          <Icon name="scan" />
          <span>Use camera</span>
        </button>
        <label class="secondary-button cursor-pointer" for="qr-upload">
          <Icon name="upload" />
          <span>Upload QR</span>
          <input
            id="qr-upload"
            aria-label="Upload QR image"
            class="sr-only"
            type="file"
            accept="image/*"
            onChange={upload}
          />
        </label>
      </div>
      <Show when={cameraOpen()}>
        <div class="camera-view">
          <video ref={video} playsinline muted aria-label="QR camera preview" />
          <div class="camera-caption">
            <span>
              {starting()
                ? 'Starting camera…'
                : 'Point your camera at a QR code'}
            </span>
            <button type="button" onClick={stop} aria-label="Stop camera">
              <Icon name="close" />
            </button>
          </div>
        </div>
      </Show>
      <Show when={error()}>
        <p class="error-message mt-4" role="alert">
          {error()}
        </p>
      </Show>
    </div>
  );
}
