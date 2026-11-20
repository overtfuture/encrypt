import type { Page } from '@playwright/test';

type Frame =
  | { type: 'open'; label: string }
  | { type: 'message'; label: string; payload: string | number[] }
  | { type: 'close'; label: string };

declare global {
  interface Window {
    emitLiveTestFrame: (frame: Frame) => Promise<void>;
    receiveLiveTestFrame: (frame: Frame) => void;
  }
}

// Substitute only the browser transport for test runners without direct UDP.
// The app still builds and authenticates codes, encrypts frames, and writes history.
export async function linkTestTransports(first: Page, second: Page) {
  for (const [local, remote] of [
    [first, second],
    [second, first],
  ] as const) {
    await local.exposeFunction('emitLiveTestFrame', (frame: Frame) =>
      remote.evaluate(
        (received) => window.receiveLiveTestFrame(received),
        frame,
      ),
    );
    await local.addInitScript(() => {
      let deliveries = Promise.resolve();
      function emit(frame: Frame) {
        const sent = deliveries.then(() => window.emitLiveTestFrame(frame));
        deliveries = sent.catch(() => {});
        return sent;
      }

      class TestChannel extends EventTarget {
        readyState: RTCDataChannelState = 'connecting';
        bufferedAmount = 0;
        bufferedAmountLowThreshold = 0;
        constructor(readonly label: string) {
          super();
        }
        open() {
          this.readyState = 'open';
          this.dispatchEvent(new Event('open'));
        }
        finish() {
          if (this.readyState === 'closed') return;
          this.readyState = 'closed';
          this.dispatchEvent(new Event('close'));
        }
        close() {
          const wasOpen = this.readyState === 'open';
          this.finish();
          if (wasOpen) void emit({ type: 'close', label: this.label });
        }
        send(data: string | Uint8Array) {
          if (this.readyState !== 'open')
            throw new Error('The test channel is closed.');
          const payload = typeof data === 'string' ? data : Array.from(data);
          this.bufferedAmount += payload.length;
          const drained = () => {
            const before = this.bufferedAmount;
            this.bufferedAmount -= payload.length;
            if (
              before > this.bufferedAmountLowThreshold &&
              this.bufferedAmount <= this.bufferedAmountLowThreshold
            )
              this.dispatchEvent(new Event('bufferedamountlow'));
          };
          void emit({ type: 'message', label: this.label, payload }).then(
            drained,
            drained,
          );
        }
      }

      class TestPeer extends EventTarget {
        iceGatheringState: RTCIceGatheringState = 'complete';
        connectionState: RTCPeerConnectionState = 'new';
        localDescription?: RTCSessionDescriptionInit;
        channels = new Map<string, TestChannel>();

        constructor(config: RTCConfiguration) {
          super();
          if (config.iceServers?.length !== 0)
            throw new Error('Live chat should use only direct ICE candidates.');
          window.receiveLiveTestFrame = (frame) => {
            if (this.connectionState === 'closed') return;
            if (frame.type === 'open') {
              const channel = this.createDataChannel(frame.label);
              this.dispatchEvent(
                Object.assign(new Event('datachannel'), {
                  channel,
                }),
              );
              this.connected();
              channel.open();
            } else if (frame.type === 'message') {
              this.channels.get(frame.label)?.dispatchEvent(
                new MessageEvent('message', {
                  data:
                    typeof frame.payload === 'string'
                      ? frame.payload
                      : new Uint8Array(frame.payload).buffer,
                }),
              );
            } else {
              this.channels.get(frame.label)?.finish();
            }
          };
        }

        private connected() {
          if (this.connectionState === 'connected') return;
          this.connectionState = 'connected';
          this.dispatchEvent(new Event('connectionstatechange'));
        }

        createDataChannel(label: string) {
          const channel = new TestChannel(label);
          this.channels.set(label, channel);
          return channel;
        }

        createOffer() {
          return {
            type: 'offer' as const,
            sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 1 192.0.2.1 8000 typ host\r\n',
          };
        }

        createAnswer() {
          return { ...this.createOffer(), type: 'answer' as const };
        }

        async setLocalDescription(description: RTCSessionDescriptionInit) {
          this.localDescription = description;
        }

        async setRemoteDescription(description: RTCSessionDescriptionInit) {
          if (description.type !== 'answer') return;
          this.connected();
          for (const channel of this.channels.values()) {
            if (this.connectionState === 'closed') return;
            await emit({ type: 'open', label: channel.label });
            channel.open();
          }
        }

        close() {
          this.connectionState = 'closed';
          this.dispatchEvent(new Event('connectionstatechange'));
        }
      }

      Object.defineProperty(window, 'RTCPeerConnection', { value: TestPeer });
    });
  }
}
