import type { Page } from '@playwright/test';

type Frame =
  | { type: 'open'; label: string }
  | { type: 'message'; payload: string }
  | { type: 'close' };

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
      class TestChannel extends EventTarget {
        readyState: RTCDataChannelState = 'connecting';
        bufferedAmount = 0;
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
          if (wasOpen) void window.emitLiveTestFrame({ type: 'close' });
        }
        send(payload: string) {
          if (this.readyState !== 'open')
            throw new Error('The test channel is closed.');
          void window.emitLiveTestFrame({ type: 'message', payload });
        }
      }

      class TestPeer extends EventTarget {
        iceGatheringState: RTCIceGatheringState = 'complete';
        connectionState: RTCPeerConnectionState = 'new';
        localDescription?: RTCSessionDescriptionInit;
        channel?: TestChannel;

        constructor(config: RTCConfiguration) {
          super();
          if (config.iceServers?.length !== 0)
            throw new Error('Live chat should use only direct ICE candidates.');
          window.receiveLiveTestFrame = (frame) => {
            if (this.connectionState === 'closed') return;
            if (frame.type === 'open') {
              this.channel = new TestChannel(frame.label);
              this.dispatchEvent(
                Object.assign(new Event('datachannel'), {
                  channel: this.channel,
                }),
              );
              this.connected();
            } else if (frame.type === 'message') {
              this.channel?.dispatchEvent(
                new MessageEvent('message', { data: frame.payload }),
              );
            } else {
              this.channel?.finish();
            }
          };
        }

        private connected() {
          this.connectionState = 'connected';
          this.dispatchEvent(new Event('connectionstatechange'));
          this.channel?.open();
        }

        createDataChannel(label: string) {
          this.channel = new TestChannel(label);
          return this.channel;
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
          if (description.type !== 'answer' || !this.channel) return;
          this.connected();
          await window.emitLiveTestFrame({
            type: 'open',
            label: this.channel.label,
          });
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
