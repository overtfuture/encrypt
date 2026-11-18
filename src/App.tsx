import IdentityMessages from './components/IdentityMessages';

export default function App() {
  return (
    <div class="site-shell">
      <header class="site-header">
        <span class="wordmark">
          encrypt this<span aria-hidden="true">✳</span>
        </span>
      </header>
      <IdentityMessages />
      <footer class="site-footer">
        Encrypted in this browser. Shared by you.
      </footer>
    </div>
  );
}
