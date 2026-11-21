import { expect, test, vi } from 'vitest';
import { bindLiveFiles, MAX_LIVE_FILE_BYTES } from './live-files';
import { generateIdentity } from './messages';

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer?: TestChannel;
  damageNextChunk = false;

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  send(value: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 'open') throw new Error('Channel closed');
    const chunk = typeof value === 'string' ? undefined : value.slice();
    if (chunk && this.damageNextChunk) {
      chunk[chunk.length - 1] ^= 1;
      this.damageNextChunk = false;
    }
    queueMicrotask(() => {
      this.peer?.dispatchEvent(
        new MessageEvent('message', { data: chunk?.buffer ?? value }),
      );
    });
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

test('a damaged encrypted attachment is never delivered', async () => {
  const [alice, bob] = await Promise.all([
    generateIdentity('Alice'),
    generateIdentity('Bob'),
  ]);
  const a = new TestChannel();
  const b = new TestChannel();
  a.peer = b;
  b.peer = a;
  const received = vi.fn();
  const issue = vi.fn();
  const ready = vi.fn();
  const sender = bindLiveFiles(a as unknown as RTCDataChannel, {
    identity: alice,
    contact: bob.contact,
    session: 'test session',
    ready,
    receive: vi.fn(),
    issue: vi.fn(),
  });
  const recipient = bindLiveFiles(b as unknown as RTCDataChannel, {
    identity: bob,
    contact: alice.contact,
    session: 'test session',
    ready: vi.fn(),
    receive: received,
    issue,
  });
  try {
    a.open();
    b.open();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith(true));
    const oversized = new File(
      [new Uint8Array(MAX_LIVE_FILE_BYTES + 1)],
      'too-big.txt',
    );
    await expect(sender.send(oversized)).rejects.toThrow('10 MB');
    expect(received).not.toHaveBeenCalled();
    a.damageNextChunk = true;
    await expect(
      sender.send(new File(['Original contents'], 'example.txt')),
    ).rejects.toThrow('did not confirm');
    expect(received).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith(
      'A live attachment could not be authenticated or opened.',
    );
  } finally {
    sender.stop();
    recipient.stop();
  }
});
