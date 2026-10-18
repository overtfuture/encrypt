export function Envelope() {
  return (
    <div class="envelope-scene" aria-hidden="true">
      <svg
        class="envelope-icon"
        width="180"
        height="160"
        viewBox="0 0 180 160"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m20 71 70-45 70 45v72H20Z" fill="var(--color-paper)" />
        <rect
          x="40"
          y="15"
          width="100"
          height="110"
          rx="3"
          fill="var(--color-paper)"
        />
        <path
          d="M58 39h38m-38 13h64M58 65h64M58 78h40"
          stroke="var(--color-line)"
        />
        <path d="m20 71 70 44 70-44v72H20Z" fill="var(--color-paper)" />
        <path d="m20 143 52-39m88 39-52-39" stroke="var(--color-line)" />
        <circle
          cx="90"
          cy="113"
          r="15"
          fill="var(--color-accent-soft)"
          stroke="var(--color-accent)"
        />
        <path d="M90 105v8l5 3" stroke="var(--color-accent)" />
      </svg>
    </div>
  );
}
