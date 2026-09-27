import { Component, type ReactNode } from 'react';

/** A panel that throws while rendering must not take the world, the sidebars and the connection footer with it.
 * Opening a different view (a new `resetKey`) retries; the children are never remounted just for that. */
export class PanelBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('A panel could not be displayed.', error); }
  componentDidUpdate(previous: { resetKey?: string }) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="form-error" role="alert">
      <p>This panel could not be displayed. The rest of the town is unaffected.</p>
      <button type="button" className="button" onClick={() => this.setState({ failed: false })}>Try again</button>
    </div>;
  }
}
