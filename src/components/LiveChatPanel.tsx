import { createEffect, createSignal, Match, Show, Switch } from 'solid-js';
import type { LiveState } from '../lib/identity/live-chat';
import { Icon } from './Icon';

export default function LiveChatPanel(props: {
  state: LiveState | undefined;
  contact: string;
  activeContact: string;
  busy: boolean;
  onInvite: () => void;
  onJoin: (value: string) => void;
  onConnect: (value: string) => void;
  onStop: () => void;
  onCopy: (value: string) => void;
}) {
  const [invite, setInvite] = createSignal('');
  const [reply, setReply] = createSignal('');
  const copying = () => props.busy || !props.state?.code;
  createEffect(() => {
    if (props.state?.phase === 'reply') setInvite('');
  });

  return (
    <div class="view-stack live-panel">
      <Switch>
        <Match when={props.state && props.state.contact !== props.contact}>
          <p>You already have a live chat open with {props.activeContact}.</p>
        </Match>
        <Match when={!props.state}>
          <p>
            Start a direct chat, or join using an invite from this contact.
            Share codes in a channel you already use and keep both app tabs open
            and unlocked.
          </p>
          <p class="field-help">
            Connections work when your browsers can reach each other directly,
            usually on the same network.
          </p>
          <button
            class="primary-button"
            disabled={props.busy}
            onClick={() => {
              setReply('');
              props.onInvite();
            }}
          >
            <Icon name="link" /> Create invite
          </button>
          <div class="divider-label">Already have an invite?</div>
          <label for="live-invite-input">Paste invite code</label>
          <textarea
            id="live-invite-input"
            rows="3"
            value={invite()}
            maxlength="31000"
            spellcheck={false}
            onInput={(event) => setInvite(event.currentTarget.value)}
          />
          <button
            class="secondary-button"
            disabled={props.busy || !invite().trim()}
            onClick={() => props.onJoin(invite())}
          >
            Join live chat
          </button>
        </Match>
        <Match when={props.state?.phase === 'preparing'}>
          <p role="status">Preparing the direct connection…</p>
        </Match>
        <Match when={props.state?.phase === 'invite'}>
          <p>
            Send this invite code to your contact. Ask them to send back a reply
            code, then paste it into this tab.
          </p>
          <label for="live-invite">Invite code</label>
          <textarea
            id="live-invite"
            rows="2"
            readonly
            value={props.state?.code ?? ''}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            class="primary-button"
            disabled={copying()}
            onClick={() => props.onCopy(props.state!.code!)}
          >
            <Icon name="copy" /> Copy invite code
          </button>
          <label for="live-reply-input">Paste reply code</label>
          <textarea
            id="live-reply-input"
            rows="3"
            value={reply()}
            maxlength="31000"
            spellcheck={false}
            onInput={(event) => setReply(event.currentTarget.value)}
          />
          <button
            class="secondary-button"
            disabled={props.busy || !reply().trim()}
            onClick={() => props.onConnect(reply())}
          >
            Connect
          </button>
        </Match>
        <Match when={props.state?.phase === 'reply'}>
          <p>
            Send this reply code back to your contact. The chat connects when
            they paste it into the tab that created the invite.
          </p>
          <label for="live-reply">Reply code</label>
          <textarea
            id="live-reply"
            rows="2"
            readonly
            value={props.state?.code ?? ''}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            class="primary-button"
            disabled={copying()}
            onClick={() => props.onCopy(props.state!.code!)}
          >
            <Icon name="copy" /> Copy reply code
          </button>
        </Match>
        <Match when={props.state?.phase === 'connecting'}>
          <p role="status">Connecting to your contact…</p>
        </Match>
        <Match when={props.state?.phase === 'reconnecting'}>
          <p role="status">Trying to reconnect…</p>
        </Match>
        <Match when={props.state?.phase === 'connected'}>
          <p role="status">Live chat connected.</p>
        </Match>
      </Switch>
      <Show when={props.state}>
        <button
          class="quiet-button"
          disabled={props.busy}
          onClick={() => {
            setInvite('');
            setReply('');
            props.onStop();
          }}
        >
          End live chat
        </button>
      </Show>
    </div>
  );
}
