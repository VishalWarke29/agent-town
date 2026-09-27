import { Component, type ReactNode } from 'react';

/** The outermost safety net around <App/> (Gap 16). `WorldBoundary` and `PanelBoundary` live inside
 * the app and catch their own failures first, so the world and the rest of the panels stay up; this
 * only ever sees a throw neither of them caught, or a failure in the app shell itself. A crash must
 * never look like an empty page, so this shows a plain recovery screen instead of nothing. */
export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Console only. The recovery page itself never shows a stack, a file path, or any other detail.
    console.error(error instanceof Error ? error.message : 'Agent Town could not display this page.');
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 18, padding: 32, textAlign: 'center',
          background: '#e7eadc', color: 'var(--ink, #35482f)',
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Agent Town ran into a problem</h1>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--muted, #53654a)' }}>
            Reload the page to continue. Nothing that was already saved is affected.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 4, minHeight: 44, minWidth: 44, padding: '10px 22px', borderRadius: 10,
              border: 'none', background: 'var(--green, #496345)', color: '#faf7ea', fontSize: 13,
              fontWeight: 600, cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
