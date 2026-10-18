export function Envelope(props: { open?: boolean }) {
  return (
    <div
      class="envelope-scene"
      classList={{ 'is-open': props.open }}
      aria-hidden="true"
    >
      <div class="orbit orbit-one" />
      <div class="orbit orbit-two" />
      <span class="orbit-spark spark-one">✳</span>
      <span class="orbit-spark spark-two">+</span>
      <div class="envelope">
        <div class="letter">
          <span>A little something</span>
          <strong>for later.</strong>
          <div />
          <div />
          <div />
        </div>
        <div class="envelope-back" />
        <div class="envelope-flap" />
        <div class="envelope-front" />
        <span class="wax-seal">
          a<span>✳</span>
        </span>
      </div>
    </div>
  );
}
