import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import QRCode from 'qrcode';
import { guestPrefix } from '../lib/guest-message';
import { fingerprint, link, payload } from '../lib/identity/encoding';
import {
  CONTACT_CARD_LIMIT,
  contactText,
  createMessage,
  decryptMessage,
  parseContact,
  parseMessage,
  timedEnvelope,
  unwrapMessage,
  type Contact,
} from '../lib/identity/messages';
import {
  historyKey,
  messageSource,
  openHistory,
  sealHistory,
  validateMessagePayload,
} from '../lib/identity/history';
import { createLiveChat, type LiveState } from '../lib/identity/live-chat';
import {
  createPasskey,
  registerPasskey,
  unlockPasskey,
} from '../lib/identity/passkeys';
import {
  createVault,
  parseBackup,
  recoverVault,
  rewrapVault,
  unlockVault,
  type Binding,
  type Session,
  type Vault,
} from '../lib/identity/vault';
import {
  clearHistory,
  deleteContact,
  deleteIdentityDatabase,
  dismissPending,
  enqueueMessage,
  findImported,
  PENDING_LIMIT,
  STAGED_LINKS_KEY,
  readContacts,
  readPending,
  readVault,
  saveContact,
  saveMessage,
  saveVault,
  verifyContact,
  type PendingMessage,
  type SavedContact,
} from '../lib/identity/storage';
import {
  importBeacon,
  timeForRound,
  TimelockUnavailableError,
} from '../lib/timelock';
import Conversation, {
  Avatar,
  contactName,
  Trust,
  type Draft,
} from './Conversation';
import ProfileBackup, { readTextFile, type Action } from './ProfileBackup';
import ScanInput from './ScanInput';
import { Icon } from './Icon';
import LiveChatPanel from './LiveChatPanel';
import { GuestMessageComposer } from './GuestMessage';

type View =
  | 'chat'
  | 'contact'
  | 'share'
  | 'import'
  | 'profile'
  | 'details'
  | 'live'
  | 'guest'
  | 'guest-contact';
type Unlocked = { profile: Session; key: CryptoKey };
type PendingNotice = { entry: PendingMessage; round?: number; sender?: string };
const EMPTY_DRAFT: Draft = { body: '', timed: false, opening: '' };
const IDLE = 5 * 60 * 1000;
const viewTitle = {
  contact: 'Add contact',
  share: 'Share my contact',
  import: 'Open an encrypted message',
  profile: 'Backup & recovery',
  details: 'Contact details',
  live: 'Live chat',
  guest: 'New guest message',
  'guest-contact': 'Share contact as guest',
};

function ContactMenu(props: {
  name: string;
  busy: boolean;
  onClear: () => void;
  onDelete: () => void;
}) {
  let menu!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  function close() {
    menu.open = false;
    trigger.focus();
  }
  return (
    <details
      class="contact-menu"
      name="contact-actions"
      ref={menu}
      onFocusOut={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !menu.contains(event.relatedTarget)
        )
          menu.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu.open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <summary
        class="quiet-button contact-menu-trigger"
        aria-label={`Actions for ${props.name}`}
        ref={trigger}
      >
        <span aria-hidden="true">⋯</span>
      </summary>
      <div class="contact-menu-actions">
        <button
          class="quiet-button"
          disabled={props.busy}
          onClick={() => {
            close();
            props.onClear();
          }}
        >
          Clear messages
        </button>
        <button
          class="quiet-button"
          disabled={props.busy}
          onClick={() => {
            close();
            props.onDelete();
          }}
        >
          Delete contact
        </button>
      </div>
    </details>
  );
}

export default function IdentityMessages(props: {
  onOpenGuest: (input: string) => void;
  onResetData: () => void;
}) {
  const [record, setRecord] = createSignal<Vault>();
  const [session, setSession] = createSignal<Unlocked>();
  const [loaded, setLoaded] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [name, setName] = createSignal('');
  const [enrollment, setEnrollment] = createSignal<{
    label: string;
    binding: Binding;
  }>();
  const [contacts, setContacts] = createSignal<SavedContact[]>([]);
  const [selected, setSelected] = createSignal('');
  const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});
  const [revision, setRevision] = createSignal(0);
  const [newestOutgoing, setNewestOutgoing] = createSignal<{
    contact: string;
    id: string;
  }>();
  const [view, setView] = createSignal<View>('chat');
  const [source, setSource] = createSignal('');
  const [review, setReview] = createSignal<Contact>();
  const [qr, setQr] = createSignal('');
  const [messageInput, setMessageInput] = createSignal('');
  const [beacon, setBeacon] = createSignal('');
  const [beaconFor, setBeaconFor] = createSignal('');
  const [pending, setPending] = createSignal<PendingNotice[]>([]);
  const [inboxReady, setInboxReady] = createSignal(false);
  const [staged, setStaged] = createSignal<string[]>([]);
  const [liveState, setLiveState] = createSignal<LiveState>();
  const liveChat = createLiveChat({
    sessionToken: () => epoch,
    state: (next) => {
      const previousPhase = liveState()?.phase;
      setLiveState(next);
      if (
        next?.phase === 'connected' &&
        previousPhase !== 'connected' &&
        view() === 'live' &&
        selected() === next.contact
      ) {
        setView('chat');
        setStatus('Live chat connected.');
      }
    },
    status: setStatus,
    issue: setError,
    receive: receiveLive,
  });

  let epoch = 0;
  let lastActivity = Date.now();
  let controller: AbortController | undefined;
  let channel: BroadcastChannel | undefined;
  let refreshContacts = false;
  let addContactButton: HTMLButtonElement | undefined;
  const currentContact = () =>
    contacts().find((row) => row.contact.id === selected());
  const myContact = () => contactText(record()!.contact);
  const myContactLink = () => link(myContact());
  const sortedContacts = createMemo(() =>
    [...contacts()].sort((left, right) =>
      contactName(left.contact).localeCompare(contactName(right.contact)),
    ),
  );
  const currentDraft = () => drafts()[selected()] ?? EMPTY_DRAFT;

  function lock() {
    epoch++;
    controller?.abort();
    liveChat.stop();
    session()?.profile.lock();
    setSession(undefined);
    setEnrollment(undefined);
    setContacts([]);
    setSelected('');
    setDrafts({});
    setNewestOutgoing(undefined);
    setView('chat');
    setSource('');
    setReview(undefined);
    setQr('');
    setMessageInput('');
    setBeacon('');
    setBeaconFor('');
    setPending([]);
    setError('');
    setStatus('');
    setBusy(false);
  }

  function errorMessage(cause: unknown) {
    return cause instanceof DOMException && cause.name === 'NotAllowedError'
      ? 'Passkey prompt cancelled or unavailable. Try again with your passkey or security key.'
      : cause instanceof Error
        ? cause.message
        : 'The operation could not finish.';
  }

  function run(action: Action, clearMessages = true) {
    if (busy()) return;
    const attempt = epoch;
    const active = () => attempt === epoch;
    const signal = (controller = new AbortController()).signal;
    if (clearMessages) {
      setError('');
      setStatus('');
    }
    setBusy(true);
    void (async () => {
      try {
        await action(active, signal);
      } catch (cause) {
        if (active()) setError(errorMessage(cause));
      } finally {
        if (active()) setBusy(false);
      }
    })();
  }

  function stage(input: string, messageOnly = false) {
    const value = payload(input);
    if (!messageOnly && value.startsWith('ec1.')) {
      if (value.length > CONTACT_CARD_LIMIT)
        throw new Error('Contact link is too large.');
      if (!/^ec1\.[\w-]+$/.test(value))
        throw new Error('Malformed contact link.');
    } else {
      validateMessagePayload(value);
    }
    if (!staged().includes(value)) {
      if (staged().length >= PENDING_LIMIT)
        throw new Error('Too many links are waiting to open.');
      replaceStaged([...staged(), value]);
    }
    setInboxReady(true);
  }

  onMount(() => {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(STAGED_LINKS_KEY) ?? '[]',
      );
      if (Array.isArray(saved)) {
        for (const value of saved.slice(0, PENDING_LIMIT)) {
          if (typeof value === 'string') stage(value);
        }
      }
    } catch {
      // Session storage is optional. Keep any links staged in this page.
    }
    const receiveFragment = () => {
      const hash = location.hash;
      if (!hash || guestPrefix(hash.slice(1))) return;
      try {
        stage(hash);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        history.replaceState(
          history.state,
          '',
          location.pathname + location.search,
        );
      }
    };
    receiveFragment();
    window.addEventListener('hashchange', receiveFragment);

    void readVault()
      .then(setRecord, (cause: unknown) => {
        setUnavailable(true);
        setError('The saved profile cannot be read. ' + errorMessage(cause));
      })
      .finally(() => setLoaded(true));

    const check = () => {
      if (session() && Date.now() - lastActivity >= IDLE) lock();
    };
    const touch = () => {
      check();
      lastActivity = Date.now();
    };
    const timer = setInterval(check, 1000);
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    window.addEventListener('pagehide', lock);
    document.addEventListener('visibilitychange', check);
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel('encrypt-this/local-chats');
      channel.onmessage = (event) => {
        if (event.data === 'vault') {
          void readVault().then(
            (vault) => {
              if (vault) setRecord(vault);
            },
            () => {},
          );
          return;
        }
        if (!session()) return;
        refreshContacts = true;
        setRevision((value) => value + 1);
        setInboxReady(true);
      };
    }
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener('hashchange', receiveFragment);
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pagehide', lock);
      document.removeEventListener('visibilitychange', check);
      channel?.close();
      lock();
    });
  });

  async function activate(profile: Session, active: () => boolean) {
    try {
      const key = await historyKey(profile);
      const rows = await readContacts().catch(() => {
        if (active())
          setError(
            'Saved contacts could not be read. Your backup is still available.',
          );
        return [];
      });
      if (!active()) return;
      setName('');
      setEnrollment(undefined);
      setContacts(rows);
      lastActivity = Date.now();
      setSession({ profile, key });
      setInboxReady(true);
    } finally {
      if (session()?.profile !== profile) profile.lock();
    }
  }

  function createProfile() {
    run(async (active, signal) => {
      if (record() || unavailable())
        throw new Error('A local profile already exists or cannot be read.');
      const label = name().trim();
      const binding = await registerPasskey(label, signal);
      if (active()) setEnrollment({ label, binding });
    });
  }

  function resetBrowser() {
    if (
      busy() ||
      !window.confirm(
        'Delete all Encrypt This data in this browser? Your local profile, contacts, chat history, and waiting links will be permanently removed. Passkeys and exported backups are managed separately.',
      )
    )
      return;
    run(async (active) => {
      await deleteIdentityDatabase(() => {
        if (active())
          setError('Close other tabs using Encrypt This to finish resetting.');
      });
      props.onResetData();
    });
  }

  function verifyProfile() {
    run(async (active, signal) => {
      const pending = enrollment();
      if (!pending || record() || unavailable()) return;
      const { label, binding } = pending;
      const prf = await unlockPasskey(binding, signal).catch(
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'NotAllowedError')
            throw new Error(
              'The passkey was created, but verification did not finish. Select Verify passkey and choose the same passkey manager or security key you used to save it.',
            );
          throw cause;
        },
      );
      try {
        if (!active()) return;
        const next = await createVault(label, binding, prf);
        try {
          if (!active()) return;
          await saveVault(next.record);
          updateVault(next.record);
          if (active()) await activate(next.session, active);
        } finally {
          if (session()?.profile !== next.session) next.session.lock();
        }
      } finally {
        prf.fill(0);
      }
    });
  }

  function unlockProfile() {
    run(async (active, signal) => {
      const saved = record()!;
      const prf = await unlockPasskey(saved.binding, signal);
      try {
        if (!active()) return;
        const latest = await readVault();
        if (!active()) return;
        if (!latest) throw new Error('The saved profile is unavailable.');
        setRecord(latest);
        if (
          latest.binding.id !== saved.binding.id ||
          latest.binding.input !== saved.binding.input ||
          latest.binding.rp !== saved.binding.rp
        )
          throw new Error(
            'Your passkey was updated in another tab. Unlock again.',
          );
        await activate(await unlockVault(latest, prf), active);
      } finally {
        prf.fill(0);
      }
    });
  }

  function restoreProfile(backup: string, code?: string) {
    run(async (active, signal) => {
      const previous = record();
      const saved = previous ?? parseBackup(backup);
      let profile: Session | undefined;
      try {
        let next = saved;
        if (code !== undefined) {
          profile = await recoverVault(saved, code);
          if (!active()) return;
          const { binding, prf } = await createPasskey(saved.contact.n, signal);
          try {
            if (!active()) return;
            next = await rewrapVault(saved, profile, binding, prf);
          } finally {
            prf.fill(0);
          }
        } else {
          const prf = await unlockPasskey(saved.binding, signal);
          try {
            profile = await unlockVault(saved, prf);
          } finally {
            prf.fill(0);
          }
        }
        if (!active()) return;
        await saveVault(next, previous);
        updateVault(next);
        if (active()) {
          await activate(profile, active);
          if (active())
            setStatus('Profile restored. Export an updated backup.');
        }
      } finally {
        if (profile && session()?.profile !== profile) profile.lock();
      }
    });
  }

  function notifyChange() {
    setRevision((value) => value + 1);
    channel?.postMessage(null);
  }

  function updateVault(vault: Vault) {
    setRecord(vault);
    channel?.postMessage('vault');
  }

  function openThread(contact: string) {
    setSelected(contact);
    setView('chat');
  }

  function updateContacts(rows: SavedContact[]) {
    const saved = new Set(rows.map((row) => row.contact.id));
    batch(() => {
      const id = selected();
      if (id && !saved.has(id)) {
        setSelected('');
        if (view() === 'details' || view() === 'live') setView('chat');
      }
      const live = liveState();
      if (live && !saved.has(live.contact)) liveChat.stop();
      const outgoing = newestOutgoing();
      if (outgoing && !saved.has(outgoing.contact))
        setNewestOutgoing(undefined);
      setDrafts((previous) => {
        const entries = Object.entries(previous);
        const kept = entries.filter(([id]) => saved.has(id));
        return kept.length === entries.length
          ? previous
          : Object.fromEntries(kept);
      });
      setContacts(rows);
    });
  }

  async function importQueued(
    entry: PendingMessage,
    current: Unlocked,
    active: () => boolean,
  ): Promise<PendingNotice | undefined> {
    const { owner, source, payload: value } = entry;
    const previous = await findImported(owner, source);
    if (!active()) return;
    if (previous) {
      const opened = await openHistory(current.key, previous);
      if (!active()) return;
      if (!contacts().some((row) => row.contact.id === opened.contact))
        return { entry, sender: opened.contact };
      await dismissPending(owner, source);
      if (active()) {
        openThread(opened.contact);
        setStatus('This message is already in the conversation.');
      }
      return;
    }

    let body: string;
    let message: ReturnType<typeof parseMessage>;
    try {
      const inner = await unwrapMessage(value);
      if (!active()) return;
      message = parseMessage(inner);
      if (message.r !== owner)
        throw new Error('This link was encrypted for a different profile.');
      const sender = contacts().find((row) => row.contact.id === message.s);
      if (!sender) return { entry, sender: message.s };
      body = await decryptMessage(
        current.profile.identity,
        sender.contact,
        inner,
      );
    } catch (cause) {
      if (!active()) return;
      if (
        cause instanceof TimelockUnavailableError &&
        cause.reason === 'pending'
      ) {
        return { entry, round: timedEnvelope(value).t };
      }
      await dismissPending(owner, source);
      if (active()) setError(errorMessage(cause));
      return;
    }
    if (!active()) return;
    const row = await sealHistory(current.key, {
      owner,
      source,
      body,
      direction: 'incoming',
      savedAt: entry.savedAt,
      contact: message.s,
      id: message.m,
      round: message.t,
    });
    if (!active()) return;
    const inserted = await saveMessage(row);
    if (active()) {
      openThread(message.s);
      setStatus(
        inserted
          ? 'Message added to the conversation.'
          : 'This message is already in the conversation.',
      );
      if (inserted) notifyChange();
      else setRevision((value) => value + 1);
    } else if (inserted) channel?.postMessage(null);
  }

  function removeStaged(value: string) {
    replaceStaged(staged().filter((item) => item !== value));
  }

  function replaceStaged(values: string[]) {
    setStaged(values);
    try {
      if (values.length)
        sessionStorage.setItem(STAGED_LINKS_KEY, JSON.stringify(values));
      else sessionStorage.removeItem(STAGED_LINKS_KEY);
    } catch {
      // The active tab can still hold and open links in memory.
    }
  }

  async function processInbox(active: () => boolean) {
    const current = session()!;
    const owner = current.profile.identity.contact.id;
    if (refreshContacts) {
      refreshContacts = false;
      try {
        const next = await readContacts();
        if (active()) updateContacts(next);
      } catch {
        if (active()) setError('Saved contacts could not be refreshed.');
      }
    }
    const openedHere = new Map<string, PendingMessage>();
    for (const value of [...staged()]) {
      if (!active()) return;
      if (value.startsWith('ec1.')) {
        try {
          const contact = await parseContact(value);
          if (!active()) return;
          setSource(value);
          setReview(contact);
          setView('contact');
        } catch (cause) {
          if (active()) setError(errorMessage(cause));
        }
        if (active()) removeStaged(value);
      } else {
        try {
          const source = await messageSource(value);
          if (!active()) return;
          const entry = { owner, source, payload: value, savedAt: Date.now() };
          await enqueueMessage(entry);
          openedHere.set(source, entry);
          if (active()) removeStaged(value);
        } catch (cause) {
          if (active()) setError(errorMessage(cause));
        }
      }
    }
    const saved = await readPending(owner);
    const entries = new Map(openedHere);
    for (const entry of saved) entries.set(entry.source, entry);
    const notices: PendingNotice[] = [];
    for (const entry of entries.values()) {
      if (!active()) return;
      try {
        const notice = await importQueued(entry, current, active);
        if (notice) notices.push(notice);
      } catch (cause) {
        if (!active()) return;
        notices.push({ entry });
        setError(errorMessage(cause));
      }
    }
    if (active()) setPending(notices);
  }

  createEffect(() => {
    if (!session() || busy() || !inboxReady()) return;
    setInboxReady(false);
    untrack(() => run(processInbox, false));
  });

  function setContactSource(value: string) {
    setSource(value);
    setReview(undefined);
  }

  function addContact() {
    setContactSource('');
    setView('contact');
  }

  function saveReviewed() {
    run(async (active) => {
      const contact = review()!;
      await saveContact(contact);
      const next = await readContacts();
      if (!active()) {
        channel?.postMessage(null);
        return;
      }
      updateContacts(next);
      setContactSource('');
      openThread(contact.id);
      notifyChange();
      setInboxReady(true);
    });
  }

  function removeContact(contact: Contact) {
    if (
      !window.confirm(
        `Delete ${contactName(contact)} from your contacts? Add them again to see your saved messages.`,
      )
    )
      return;
    run(async (active) => {
      await deleteContact(contact.id);
      if (active()) {
        updateContacts(
          contacts().filter((row) => row.contact.id !== contact.id),
        );
        setStatus('Contact deleted.');
        if (document.activeElement === document.body) addContactButton?.focus();
      }
      channel?.postMessage(null);
    });
  }

  function clearThread(contact: Contact) {
    const owner = session()?.profile.identity.contact.id;
    if (
      !owner ||
      !window.confirm(
        `Clear all saved messages with ${contactName(contact)} from this browser? This can’t be undone.`,
      )
    )
      return;
    run(async (active) => {
      await clearHistory(owner, contact.id);
      if (active()) {
        if (newestOutgoing()?.contact === contact.id)
          setNewestOutgoing(undefined);
        setStatus('Messages cleared.');
        notifyChange();
      } else channel?.postMessage(null);
    });
  }

  function shareContact() {
    setView('share');
    if (qr() || busy()) return;
    run(async (active) => {
      const image = await QRCode.toDataURL(myContact(), {
        errorCorrectionLevel: 'M',
        width: 360,
        margin: 4,
      });
      if (active()) setQr(image);
    });
  }

  function copy(value: string) {
    run(async (active) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        throw new Error(
          'Clipboard access was unavailable. Select and copy the text manually.',
        );
      }
      if (active()) setStatus('Copied to clipboard.');
    });
  }

  async function receiveLive(
    contact: Contact,
    value: string,
    active: () => boolean,
  ) {
    const current = session();
    if (!current || !active()) return;
    const message = parseMessage(value);
    if (message.t !== null)
      throw new Error('Timed messages must be shared as links.');
    const body = await decryptMessage(current.profile.identity, contact, value);
    const source = await messageSource(value);
    if (!active()) return;
    const row = await sealHistory(current.key, {
      owner: current.profile.identity.contact.id,
      contact: contact.id,
      id: message.m,
      direction: 'incoming',
      round: null,
      body,
      savedAt: Date.now(),
      source,
    });
    if (!active()) return;
    if (await saveMessage(row)) notifyChange();
  }

  function compose(sendLive: boolean) {
    run(async (active) => {
      const contact = currentContact();
      const current = session();
      if (!contact || !current) return;
      const id = contact.contact.id;
      const draft = currentDraft();
      const date = draft.timed ? new Date(draft.opening).getTime() : undefined;
      if (
        date !== undefined &&
        (!Number.isFinite(date) || date <= Date.now())
      ) {
        throw new Error('Choose an opening time in the future.');
      }
      const message = await createMessage(
        current.profile.identity,
        contact.contact,
        draft.body,
        date,
      );
      if (!active()) return;
      const row = await sealHistory(current.key, {
        owner: current.profile.identity.contact.id,
        contact: id,
        direction: 'outgoing',
        id: message.id,
        round: message.round,
        savedAt: Date.now(),
        body: draft.body,
        sharePayload: message.payload,
      });
      if (!active()) return;
      if (!(await saveMessage(row)))
        throw new Error(
          'A saved message already has this ID. Try creating the link again.',
        );
      if (active()) {
        if (drafts()[id] === draft)
          setDrafts((values) => ({ ...values, [id]: EMPTY_DRAFT }));
        if (sendLive && liveChat.send(id, message.payload)) {
          setNewestOutgoing(undefined);
          setStatus('Sent over the live connection.');
        } else {
          setNewestOutgoing({ contact: id, id: message.id });
          if (sendLive)
            setStatus(
              'The live message could not be sent. It was saved here and can be shared as a link or file.',
            );
          else
            setStatus(
              link(message.payload).length <= 8000
                ? 'Link ready to share.'
                : 'Encrypted text and file are ready to share.',
            );
        }
        notifyChange();
      } else channel?.postMessage(null);
    });
  }

  function submitMessage(value: string) {
    if (guestPrefix(payload(value))) {
      props.onOpenGuest(value);
      return;
    }
    stage(value, true);
    setMessageInput('');
    setView('chat');
  }

  function submitBeacon(round: number) {
    run(async (active) => {
      await importBeacon(beacon(), round);
      if (!active()) return;
      setBeacon('');
      setBeaconFor('');
      setInboxReady(true);
    });
  }

  function removePending(entry: PendingMessage) {
    run(async (active) => {
      await dismissPending(entry.owner, entry.source);
      if (!active()) return;
      if (beaconFor() === entry.source) {
        setBeaconFor('');
        setBeacon('');
      }
      setInboxReady(true);
      channel?.postMessage(null);
    });
  }

  const backup = () => (
    <ProfileBackup
      record={record()}
      session={session()?.profile}
      busy={busy()}
      unavailable={unavailable()}
      run={run}
      restore={restoreProfile}
      updateRecord={updateVault}
      announce={setStatus}
    />
  );

  return (
    <main class="app-content">
      <Show
        when={session()}
        fallback={
          <section class="gate" aria-label="Profile setup and unlock">
            <div class="gate-art" aria-hidden="true">
              <div class="gate-orbit orbit-one" />
              <div class="gate-orbit orbit-two" />
              <div class="gate-key">
                <Icon name="lock" />
              </div>
            </div>
            <Show
              when={loaded()}
              fallback={<p role="status">Opening local storage…</p>}
            >
              <div class="gate-card">
                <Show
                  when={record()}
                  fallback={
                    <Show
                      when={enrollment()}
                      fallback={
                        <>
                          <h1>Create your profile</h1>
                          <p>
                            Use a passkey to protect your chats on this browser.
                          </p>
                          <form
                            class="view-stack"
                            onSubmit={(event) => {
                              event.preventDefault();
                              createProfile();
                            }}
                          >
                            <label for="profile-name">
                              Display name{' '}
                              <span class="optional">Optional</span>
                            </label>
                            <input
                              id="profile-name"
                              maxlength="80"
                              autocomplete="off"
                              value={name()}
                              onInput={(event) =>
                                setName(event.currentTarget.value)
                              }
                            />
                            <button
                              class="primary-button"
                              disabled={busy() || unavailable()}
                              type="submit"
                            >
                              <Icon name="lock" /> Create profile with passkey
                            </button>
                          </form>
                          <p class="field-help">
                            Next, you’ll verify the same passkey before your
                            profile is saved.
                          </p>
                        </>
                      }
                    >
                      <h1>Verify your passkey</h1>
                      <p>
                        Use the same passkey or security key to finish setting
                        up your profile.
                      </p>
                      <button
                        class="primary-button"
                        disabled={busy() || unavailable()}
                        onClick={verifyProfile}
                      >
                        <Icon name="lock" /> Verify passkey
                      </button>
                      <button
                        class="quiet-button"
                        disabled={busy()}
                        onClick={() => {
                          setEnrollment(undefined);
                          setError('');
                        }}
                      >
                        Use a different passkey
                      </button>
                    </Show>
                  }
                >
                  {(saved) => (
                    <>
                      <Avatar name={saved().contact.n || 'Local profile'} />
                      <h1>
                        {saved().contact.n
                          ? `Unlock ${saved().contact.n}’s chats`
                          : 'Unlock your chats'}
                      </h1>
                      <p>Your conversations are encrypted on this browser.</p>
                      <button
                        class="primary-button"
                        disabled={busy()}
                        onClick={unlockProfile}
                      >
                        <Icon name="lock" /> Unlock with passkey
                      </button>
                    </>
                  )}
                </Show>
                <Show when={staged().length > 0}>
                  <p class="gate-pending">
                    <Icon name="link" /> A link is waiting for you after unlock.
                  </p>
                </Show>
                <Show when={error()}>
                  <p class="error-message" role="alert">
                    {error()}
                  </p>
                </Show>
                <button
                  class="quiet-button"
                  onClick={() => props.onOpenGuest('')}
                >
                  <Icon name="scan" /> Open guest message
                </button>
                <details class="gate-recovery">
                  <summary>Backup, recovery & compatibility</summary>
                  {backup()}
                  <p class="field-help mt-3">
                    Use a regular window to keep your local profile and chats
                    between visits. Private browsing can clear them when the
                    session ends.
                  </p>
                </details>
                <button
                  class="quiet-button reset-browser-button"
                  disabled={busy()}
                  onClick={resetBrowser}
                >
                  Reset this browser
                </button>
              </div>
            </Show>
          </section>
        }
      >
        {(current) => (
          <div class="chat-shell">
            <header class="chat-toolbar">
              <button
                class="quiet-button profile-contact"
                aria-label="Share my contact"
                onClick={shareContact}
              >
                <Icon name="link" /> My contact
                <Show when={current().profile.identity.contact.n}>
                  {(label) => (
                    <span class="profile-contact-name" aria-hidden="true">
                      {label()}
                    </span>
                  )}
                </Show>
              </button>
              <div class="toolbar-actions">
                <button class="quiet-button" onClick={() => setView('import')}>
                  <Icon name="link" /> Open link
                </button>
                <button class="quiet-button" onClick={() => setView('profile')}>
                  Profile
                </button>
                <button class="quiet-button" onClick={lock}>
                  Lock
                </button>
              </div>
            </header>
            <div class="feedback">
              <Show when={error()}>
                <p class="error-message" role="alert">
                  {error()}{' '}
                  <button class="quiet-button" onClick={() => setError('')}>
                    Dismiss
                  </button>
                </p>
              </Show>
              <Show when={status()}>
                <p class="status-message" role="status">
                  {status()}
                </p>
              </Show>
              <Show when={staged().length > 0 && !busy() && !inboxReady()}>
                <div class="pending-notice">
                  <p>Some links are waiting to be saved.</p>
                  <button
                    class="secondary-button"
                    onClick={() => setInboxReady(true)}
                  >
                    Retry links
                  </button>
                  <button
                    class="quiet-button"
                    onClick={() => replaceStaged([])}
                  >
                    Dismiss waiting links
                  </button>
                </div>
              </Show>
              <For each={pending()}>
                {(notice) => (
                  <div class="pending-notice">
                    <div>
                      <Show
                        when={notice.sender}
                        fallback={
                          <p>
                            {notice.round
                              ? `Timed link · opens ${new Date(timeForRound(notice.round)).toLocaleString()}`
                              : 'An encrypted link needs another try.'}
                          </p>
                        }
                      >
                        {(sender) => (
                          <>
                            <p>
                              Add the sender’s contact card to open this
                              message.
                            </p>
                            <p class="fingerprint">{fingerprint(sender())}</p>
                          </>
                        )}
                      </Show>
                    </div>
                    <div class="button-row">
                      <Show when={notice.sender}>
                        <button class="secondary-button" onClick={addContact}>
                          Add sender
                        </button>
                      </Show>
                      <Show when={notice.round}>
                        <button
                          class="secondary-button"
                          onClick={() => {
                            setBeacon('');
                            setBeaconFor(notice.entry.source);
                          }}
                        >
                          Unlock timed link
                        </button>
                      </Show>
                      <Show when={!notice.round && !notice.sender}>
                        <button
                          class="secondary-button"
                          onClick={() => setInboxReady(true)}
                        >
                          Retry link
                        </button>
                      </Show>
                      <button
                        class="quiet-button"
                        disabled={busy()}
                        onClick={() => removePending(notice.entry)}
                      >
                        Dismiss link
                      </button>
                    </div>
                    <Show
                      when={beaconFor() === notice.entry.source && notice.round}
                    >
                      {(round) => (
                        <div class="view-stack beacon-form">
                          <p>
                            Once the opening time passes, get the public beacon
                            and paste its JSON here.
                          </p>
                          <a
                            class="text-button"
                            href={`https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/${round()}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open public beacon in another tab
                          </a>
                          <label for="beacon-input">
                            Public drand beacon JSON
                          </label>
                          <textarea
                            id="beacon-input"
                            rows="2"
                            maxlength="2048"
                            value={beacon()}
                            onInput={(event) =>
                              setBeacon(event.currentTarget.value)
                            }
                          />
                          <button
                            class="secondary-button"
                            disabled={busy() || !beacon().trim()}
                            onClick={() => submitBeacon(round())}
                          >
                            Import public beacon
                          </button>
                        </div>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <div
              class="chat-layout"
              classList={{
                'show-main': view() !== 'chat' || !!currentContact(),
                'show-tools': view() !== 'chat',
              }}
            >
              <aside class="contact-sidebar" aria-label="Contacts">
                <div class="sidebar-heading">
                  <h1>Chats</h1>
                  <button
                    class="quiet-button"
                    ref={addContactButton}
                    onClick={addContact}
                  >
                    Add contact
                  </button>
                </div>
                <button
                  class="quiet-button guest-compose-button"
                  onClick={() => setView('guest')}
                >
                  <Icon name="mail" /> New guest message
                </button>
                <ul class="contact-list">
                  <For
                    each={sortedContacts()}
                    fallback={
                      <li class="no-contacts">
                        Saved contacts will appear here.
                      </li>
                    }
                  >
                    {(row) => (
                      <li class="contact-entry">
                        <button
                          class="contact-row"
                          classList={{
                            selected: row.contact.id === selected(),
                          }}
                          aria-current={
                            row.contact.id === selected() ? 'true' : undefined
                          }
                          onClick={() => openThread(row.contact.id)}
                        >
                          <Avatar name={contactName(row.contact)} />
                          <span class="contact-summary">
                            <span class="contact-name">
                              {contactName(row.contact)}
                            </span>
                            <Trust verified={row.verified} />
                            <Show
                              when={contacts().some(
                                (other) =>
                                  other.contact.id !== row.contact.id &&
                                  contactName(other.contact) ===
                                    contactName(row.contact),
                              )}
                            >
                              <span class="trust">
                                {fingerprint(row.contact.id).slice(0, 9)}
                              </span>
                            </Show>
                          </span>
                        </button>
                        <ContactMenu
                          name={contactName(row.contact)}
                          busy={busy()}
                          onClear={() => clearThread(row.contact)}
                          onDelete={() => removeContact(row.contact)}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </aside>
              <div class="chat-main">
                <Switch>
                  <Match when={view() === 'chat'}>
                    <Show
                      when={currentContact()?.contact.id}
                      keyed
                      fallback={
                        <div class="workspace-empty">
                          <div class="empty-icon">
                            <Icon name="mail" />
                          </div>
                          <Show
                            when={contacts().length}
                            fallback={
                              <>
                                <h2>Add a contact to begin</h2>
                                <p>
                                  Exchange contact cards with someone you want
                                  to message.
                                </p>
                              </>
                            }
                          >
                            <h2>Choose a conversation</h2>
                            <p>Select a contact to read or write messages.</p>
                          </Show>
                        </div>
                      }
                    >
                      {(id) => (
                        <Conversation
                          owner={current().profile.identity.contact.id}
                          historyKey={current().key}
                          revision={revision()}
                          contact={currentContact()!}
                          draft={currentDraft()}
                          busy={busy()}
                          newestOutgoing={
                            newestOutgoing()?.contact === id
                              ? newestOutgoing()?.id
                              : undefined
                          }
                          onDraft={(change) => {
                            const id = selected();
                            setDrafts((values) => ({
                              ...values,
                              [id]: { ...currentDraft(), ...change },
                            }));
                          }}
                          onCreate={compose}
                          onBack={() => setSelected('')}
                          onDetails={() => setView('details')}
                          onLive={() => setView('live')}
                          liveConnected={
                            liveState()?.contact === id &&
                            liveState()?.phase === 'connected'
                          }
                          onCopy={copy}
                        />
                      )}
                    </Show>
                  </Match>
                  <Match when={view() !== 'chat'}>
                    <section
                      class="workspace-view"
                      aria-label={viewTitle[view() as Exclude<View, 'chat'>]}
                    >
                      <div class="view-heading">
                        <h2>{viewTitle[view() as Exclude<View, 'chat'>]}</h2>
                        <button
                          class="quiet-button"
                          onClick={() => setView('chat')}
                        >
                          Done
                        </button>
                      </div>
                      <Switch>
                        <Match when={view() === 'live' && currentContact()}>
                          {(contact) => (
                            <LiveChatPanel
                              state={liveState()}
                              contact={contact().contact.id}
                              activeContact={
                                contacts().find(
                                  (row) =>
                                    row.contact.id === liveState()?.contact,
                                )?.contact.n || 'a contact'
                              }
                              busy={busy()}
                              onCopy={copy}
                              onInvite={() =>
                                run(async (_active, signal) =>
                                  liveChat.invite(
                                    current().profile.identity,
                                    contact().contact,
                                    signal,
                                  ),
                                )
                              }
                              onJoin={(value) =>
                                run(async (_active, signal) =>
                                  liveChat.join(
                                    current().profile.identity,
                                    contact().contact,
                                    value,
                                    signal,
                                  ),
                                )
                              }
                              onConnect={(value) =>
                                run(async () =>
                                  liveChat.connect(
                                    current().profile.identity,
                                    value,
                                  ),
                                )
                              }
                              onStop={() => {
                                liveChat.stop();
                                setError('');
                                setStatus('Live chat ended.');
                              }}
                            />
                          )}
                        </Match>
                        <Match when={view() === 'contact'}>
                          <div class="view-stack">
                            <label for="contact-import">
                              Contact to import
                            </label>
                            <textarea
                              id="contact-import"
                              rows="2"
                              maxlength="3000"
                              value={source()}
                              onInput={(event) =>
                                setContactSource(event.currentTarget.value)
                              }
                              placeholder="Paste a contact link or card"
                            />
                            <button
                              class="secondary-button"
                              disabled={busy() || !source().trim()}
                              onClick={() =>
                                run(async (active) => {
                                  const contact = await parseContact(source());
                                  if (active()) setReview(contact);
                                })
                              }
                            >
                              Review contact
                            </button>
                            <ScanInput onRead={setContactSource} />
                            <Show when={review()}>
                              {(contact) => (
                                <div class="contact-review">
                                  <strong>{contactName(contact())}</strong>
                                  <p class="fingerprint">
                                    {fingerprint(contact().id)}
                                  </p>
                                  <Show
                                    when={contacts().some(
                                      (row) =>
                                        row.contact.n === contact().n &&
                                        row.contact.id !== contact().id,
                                    )}
                                  >
                                    <p role="alert">
                                      A saved contact uses this name with a
                                      different fingerprint. This card will
                                      create a separate contact.
                                    </p>
                                  </Show>
                                  <button
                                    class="primary-button"
                                    disabled={busy()}
                                    onClick={saveReviewed}
                                  >
                                    Save reviewed contact
                                  </button>
                                </div>
                              )}
                            </Show>
                          </div>
                        </Match>
                        <Match when={view() === 'share'}>
                          <div class="view-stack">
                            <p>
                              Send your public link so someone can add you and
                              encrypt messages for your profile.
                            </p>
                            <label for="my-contact-link">My contact link</label>
                            <input
                              id="my-contact-link"
                              type="url"
                              readonly
                              value={myContactLink()}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                            <button
                              class="primary-button"
                              onClick={() => copy(myContactLink())}
                            >
                              <Icon name="copy" /> Copy contact link
                            </button>
                            <button
                              class="secondary-button"
                              onClick={() => setView('guest-contact')}
                            >
                              <Icon name="link" /> Share as guest link
                            </button>
                            <Show when={qr()}>
                              {(image) => (
                                <img
                                  class="contact-qr"
                                  src={image()}
                                  alt="My public contact QR code"
                                />
                              )}
                            </Show>
                            <label for="my-contact">My public contact</label>
                            <textarea
                              id="my-contact"
                              rows="2"
                              readonly
                              value={myContact()}
                              onFocus={(event) => event.currentTarget.select()}
                            />
                            <button
                              class="secondary-button"
                              onClick={() => copy(myContact())}
                            >
                              Copy contact text
                            </button>
                            <details>
                              <summary>My fingerprint</summary>
                              <p class="fingerprint">
                                {fingerprint(record()!.contact.id)}
                              </p>
                            </details>
                          </div>
                        </Match>
                        <Match
                          when={
                            view() === 'guest' || view() === 'guest-contact'
                          }
                        >
                          <GuestMessageComposer
                            contact={current().profile.identity.contact}
                            asContact={view() === 'guest-contact'}
                            busy={busy()}
                            run={run}
                            copy={copy}
                          />
                        </Match>
                        <Match when={view() === 'import'}>
                          <form
                            class="view-stack"
                            onSubmit={(event) => {
                              event.preventDefault();
                              run(async () => submitMessage(messageInput()));
                            }}
                          >
                            <label for="message-input">
                              Encrypted message to open
                            </label>
                            <textarea
                              id="message-input"
                              rows="3"
                              maxlength="92000"
                              value={messageInput()}
                              onInput={(event) =>
                                setMessageInput(event.currentTarget.value)
                              }
                              placeholder="Paste an encrypted link or message"
                            />
                            <button
                              class="primary-button"
                              disabled={busy() || !messageInput().trim()}
                              type="submit"
                            >
                              Open message
                            </button>
                            <label for="message-file">
                              Import encrypted message file
                            </label>
                            <input
                              id="message-file"
                              type="file"
                              onChange={(event) => {
                                const input = event.currentTarget;
                                const file = input.files?.[0];
                                input.value = '';
                                run(async (active) => {
                                  const value = await readTextFile(file, 92000);
                                  if (active() && value !== undefined)
                                    submitMessage(value);
                                });
                              }}
                            />
                          </form>
                        </Match>
                        <Match when={view() === 'profile'}>{backup()}</Match>
                        <Match when={view() === 'details' && currentContact()}>
                          {(contact) => (
                            <div class="view-stack">
                              <h3>{contactName(contact().contact)}</h3>
                              <Trust verified={contact().verified} />
                              <p class="fingerprint">
                                {fingerprint(contact().contact.id)}
                              </p>
                              <Show when={!contact().verified}>
                                <p>
                                  Compare the full fingerprint with this person
                                  through a trusted channel before marking it
                                  verified.
                                </p>
                                <button
                                  class="primary-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    run(async (active) => {
                                      await verifyContact(contact().contact.id);
                                      const rows = await readContacts();
                                      if (active()) {
                                        updateContacts(rows);
                                        setStatus('Contact marked verified.');
                                      }
                                      channel?.postMessage(null);
                                    })
                                  }
                                >
                                  I compared the full fingerprint
                                </button>
                              </Show>
                            </div>
                          )}
                        </Match>
                      </Switch>
                    </section>
                  </Match>
                </Switch>
              </div>
            </div>
          </div>
        )}
      </Show>
    </main>
  );
}
