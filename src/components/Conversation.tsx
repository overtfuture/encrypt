import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from 'solid-js';
import type { SavedContact } from '../lib/identity/contact-book';
import { link } from '../lib/identity/encoding';
import { openHistory, type ChatMessage } from '../lib/identity/history';
import { readHistory } from '../lib/identity/storage';
import { renderMessage } from '../lib/message-content';
import { timeForRound } from '../lib/timelock';
import { Icon } from './Icon';
import LiveAttachment, { type Attachment } from './LiveAttachment';
import MarkdownEditor from './MarkdownEditor';
import { downloadText } from './ProfileBackup';

export type Draft = { body: string; timed: boolean; opening: string };

export const contactName = (contact: SavedContact['contact']) =>
  contact.n || 'Unnamed contact';

export function Avatar(props: { name: string }) {
  const initials = () =>
    props.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => [...word][0])
      .join('')
      .toUpperCase();
  return (
    <span class="avatar" aria-hidden="true">
      {initials() || '?'}
    </span>
  );
}

export function Trust(props: { verified: boolean }) {
  return (
    <span class="trust" classList={{ verified: props.verified }}>
      <span aria-hidden="true" />
      {props.verified ? 'Verified' : 'Unverified'}
    </span>
  );
}

const displayTime = (date: number) =>
  new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const PAGE_SIZE = 40;

const nearBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 120;

export default function Conversation(props: {
  owner: string;
  historyKey: CryptoKey;
  revision: number;
  contact: SavedContact;
  draft: Draft;
  busy: boolean;
  liveConnected: boolean;
  canAttach: boolean;
  attachments: Attachment[];
  fileSending: boolean;
  newestOutgoing: string | undefined;
  onDraft: (change: Partial<Draft>) => void;
  onCreate: (sendLive: boolean) => void;
  onAttach: (file: File) => void;
  onBack: () => void;
  onDetails: () => void;
  onLive: () => void;
  onCopy: (value: string) => void;
}) {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [limit, setLimit] = createSignal(PAGE_SIZE);
  const [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [problem, setProblem] = createSignal('');
  const [retry, setRetry] = createSignal(0);
  const [share, setShare] = createSignal<string>();
  const newestOutgoing = createMemo(() => props.newestOutgoing);
  const entries = createMemo(() =>
    [...messages(), ...props.attachments].sort((a, b) => a.savedAt - b.savedAt),
  );
  const sendingLive = createMemo(
    () => props.liveConnected && !props.draft.timed,
  );
  let scroll: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let previousLimit = PAGE_SIZE;
  let initial = true;
  let followAttachments = true;
  let previousAttachment: Attachment | undefined;

  createEffect(() => {
    const latest = props.attachments.at(-1);
    const added = latest && latest !== previousAttachment;
    previousAttachment = latest;
    if (added && (latest.direction === 'outgoing' || followAttachments)) {
      queueMicrotask(() => {
        if (scroll?.isConnected) scroll.scrollTop = scroll.scrollHeight;
      });
    }
  });

  createEffect(() => {
    const id = newestOutgoing();
    if (id) setShare(id);
  });

  createEffect(() => {
    void props.revision;
    retry();
    const batch = limit();
    const id = props.contact.contact.id;
    const key = props.historyKey;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    setLoading(true);
    void (async () => {
      try {
        const rows = await readHistory(props.owner, id, batch + 1);
        if (cancelled) return;
        const result = await Promise.allSettled(
          rows.slice(-batch).map((row) => openHistory(key, row)),
        );
        if (cancelled) return;
        const wasNearBottom = !scroll || nearBottom(scroll);
        const height = scroll?.scrollHeight ?? 0;
        const top = scroll?.scrollTop ?? 0;
        const addedEarlier = batch > previousLimit;
        previousLimit = batch;
        const opened = result.flatMap((row) =>
          row.status === 'fulfilled' ? [row.value] : [],
        );
        setProblem(
          opened.length === result.length
            ? ''
            : 'Some saved messages could not be unlocked.',
        );
        setMore(rows.length > batch);
        setMessages(opened);
        queueMicrotask(() => {
          if (cancelled || !scroll) return;
          if (addedEarlier)
            scroll.scrollTop = top + scroll.scrollHeight - height;
          else if (initial || wasNearBottom || newestOutgoing())
            scroll.scrollTop = scroll.scrollHeight;
          initial = false;
        });
      } catch {
        if (!cancelled) setProblem('Conversation history could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
  });

  return (
    <section
      class="conversation"
      aria-label={`Conversation with ${contactName(props.contact.contact)}`}
    >
      <header class="conversation-header">
        <button class="quiet-button mobile-back" onClick={props.onBack}>
          <Icon class="back-icon" name="arrow" /> Contacts
        </button>
        <Avatar name={contactName(props.contact.contact)} />
        <div class="conversation-person">
          <h2>{contactName(props.contact.contact)}</h2>
          <Trust verified={props.contact.verified} />
        </div>
        <div class="conversation-actions">
          <button
            class="quiet-button live-chat-button"
            classList={{ connected: props.liveConnected }}
            onClick={props.onLive}
          >
            Live chat
          </button>
          <button
            class="quiet-button contact-details"
            aria-label="Contact details"
            onClick={props.onDetails}
          >
            <Icon name="info" />
            <span>Contact details</span>
          </button>
        </div>
      </header>
      <div
        class="transcript"
        ref={scroll}
        aria-label="Conversation history"
        onScroll={(event) =>
          (followAttachments = nearBottom(event.currentTarget))
        }
      >
        <Show when={more()}>
          <button
            class="quiet-button earlier-button"
            disabled={loading()}
            onClick={() => setLimit(limit() + PAGE_SIZE)}
          >
            Load earlier messages
          </button>
        </Show>
        <Show when={problem()}>
          <p class="history-feedback" role="alert">
            {problem()}{' '}
            <button class="quiet-button" onClick={() => setRetry(retry() + 1)}>
              Retry
            </button>
          </p>
        </Show>
        <Show when={!loading() && !problem() && entries().length === 0}>
          <div class="thread-empty">
            <Icon name="lock" />
            <h3>Start the conversation</h3>
            <p>
              Create an encrypted link and share it with{' '}
              {contactName(props.contact.contact)}.
            </p>
          </div>
        </Show>
        <ol class="message-list">
          <For each={entries()}>
            {(message) => {
              const outgoing = message.direction === 'outgoing';
              if ('file' in message)
                return (
                  <li class="message-row" classList={{ outgoing }}>
                    <LiveAttachment file={message.file} />
                    <div class="message-meta">
                      <time datetime={new Date(message.savedAt).toISOString()}>
                        {displayTime(message.savedAt)}
                      </time>
                    </div>
                  </li>
                );
              const sharePayload = message.sharePayload;
              const shareLink = sharePayload ? link(sharePayload) : '';
              const fits = shareLink.length <= 8000;
              return (
                <li class="message-row" classList={{ outgoing }}>
                  <div
                    class="bubble message-markdown"
                    data-testid={
                      outgoing ? 'outgoing-message' : 'identity-plaintext'
                    }
                    innerHTML={renderMessage(message.body)}
                  />
                  <div class="message-meta">
                    <time datetime={new Date(message.savedAt).toISOString()}>
                      {displayTime(message.savedAt)}
                    </time>
                    <Show when={message.round}>
                      {(round) => (
                        <span title={displayTime(timeForRound(round()))}>
                          <Icon name="clock" /> Timed
                        </span>
                      )}
                    </Show>
                    <Show when={sharePayload}>
                      <button
                        class="quiet-button share-again"
                        aria-expanded={share() === message.id}
                        onClick={() =>
                          setShare(
                            share() === message.id ? undefined : message.id,
                          )
                        }
                      >
                        Share
                      </button>
                    </Show>
                  </div>
                  <Show when={share() === message.id && sharePayload}>
                    {(encrypted) => (
                      <div class="share-sheet">
                        <Show
                          when={fits}
                          fallback={
                            <p>
                              This message is too long for a link. Share the
                              encrypted text or file.
                            </p>
                          }
                        >
                          <p>
                            Copy this link, then paste it into a message to{' '}
                            {contactName(props.contact.contact)} in your usual
                            messaging app.
                          </p>
                          <label>
                            <span>Encrypted link</span>
                            <input
                              readonly
                              value={shareLink}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                          </label>
                          <button
                            class="primary-button"
                            onClick={() => props.onCopy(shareLink)}
                          >
                            <Icon name="copy" /> Copy link
                          </button>
                        </Show>
                        <details open={!fits}>
                          <summary>Encrypted text and file</summary>
                          <label>
                            <span>Encrypted output</span>
                            <textarea
                              rows="2"
                              readonly
                              value={encrypted()}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                          </label>
                          <div class="button-row">
                            <button
                              class="secondary-button"
                              onClick={() => props.onCopy(encrypted())}
                            >
                              Copy encrypted text
                            </button>
                            <button
                              class="secondary-button"
                              onClick={() =>
                                downloadText(
                                  encrypted(),
                                  'encrypted-message.txt',
                                )
                              }
                            >
                              Download encrypted message
                            </button>
                          </div>
                        </details>
                      </div>
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
      <form
        class="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          props.onCreate(sendingLive());
        }}
      >
        <MarkdownEditor
          id="private-message"
          label="Private message"
          rows={2}
          maxLength={16000}
          value={props.draft.body}
          onInput={(body) => props.onDraft({ body })}
          placeholder="Write a private message…"
        />
        <div class="composer-fields">
          <div class="composer-options">
            <Show when={sendingLive() && props.canAttach}>
              <button
                type="button"
                class="secondary-button"
                disabled={props.fileSending}
                onClick={() => fileInput?.click()}
              >
                <Icon name="upload" />{' '}
                {props.fileSending
                  ? 'Sending attachment…'
                  : 'Attach file or photo'}
              </button>
              <input
                type="file"
                aria-label="Attach file or photo"
                tabindex="-1"
                class="sr-only"
                ref={fileInput}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  input.value = '';
                  if (file) props.onAttach(file);
                }}
              />
            </Show>
            <label class="timed-option">
              <input
                type="checkbox"
                checked={props.draft.timed}
                onChange={(event) =>
                  props.onDraft({ timed: event.currentTarget.checked })
                }
              />{' '}
              Set an opening time
            </label>
            <Show when={props.draft.timed}>
              <label for="opening-time">Opening date and time</label>
              <input
                id="opening-time"
                type="datetime-local"
                value={props.draft.opening}
                onInput={(event) =>
                  props.onDraft({ opening: event.currentTarget.value })
                }
              />
            </Show>
            <Show when={sendingLive()}>
              <button
                class="quiet-button link-instead"
                type="button"
                disabled={props.busy || !props.draft.body.trim()}
                onClick={() => props.onCreate(false)}
              >
                Create link instead
              </button>
            </Show>
          </div>
          <button
            class="primary-button"
            type="submit"
            disabled={props.busy || !props.draft.body.trim()}
          >
            <Show
              when={sendingLive()}
              fallback={
                <>
                  <Icon name="link" /> Create link
                </>
              }
            >
              <Icon name="arrow" /> Send live
            </Show>
          </button>
        </div>
      </form>
    </section>
  );
}
