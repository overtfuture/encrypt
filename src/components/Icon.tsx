import { Switch, Match } from 'solid-js';

export type IconName =
  | 'arrow'
  | 'lock'
  | 'clock'
  | 'scan'
  | 'copy'
  | 'download'
  | 'check'
  | 'link'
  | 'close'
  | 'eye'
  | 'upload'
  | 'mail'
  | 'spark';

export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg
      class={props.class ?? 'h-5 w-5'}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.name === 'arrow'}>
          <path d="M4 12h15m-6-6 6 6-6 6" />
        </Match>
        <Match when={props.name === 'lock'}>
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
        </Match>
        <Match when={props.name === 'clock'}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </Match>
        <Match when={props.name === 'scan'}>
          <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 12h10" />
        </Match>
        <Match when={props.name === 'copy'}>
          <rect x="8" y="8" width="12" height="13" rx="2" />
          <path d="M16 8V3H3v13h5" />
        </Match>
        <Match when={props.name === 'download'}>
          <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
        </Match>
        <Match when={props.name === 'check'}>
          <path d="m5 12 4 4L19 6" />
        </Match>
        <Match when={props.name === 'link'}>
          <path d="m9 15 6-6m-6 0 3-3a4.2 4.2 0 0 1 6 6l-3 3m0 0-3 3a4.2 4.2 0 0 1-6-6l3-3" />
        </Match>
        <Match when={props.name === 'close'}>
          <path d="m6 6 12 12M6 18 18 6" />
        </Match>
        <Match when={props.name === 'eye'}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </Match>
        <Match when={props.name === 'upload'}>
          <path d="M12 16V3m-4 4 4-4 4 4M4 16v5h16v-5" />
        </Match>
        <Match when={props.name === 'mail'}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 6 9 7 9-7" />
        </Match>
        <Match when={props.name === 'spark'}>
          <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z" />
        </Match>
      </Switch>
    </svg>
  );
}
