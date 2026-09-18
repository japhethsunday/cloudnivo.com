'use client';

import { Component } from 'react';

/**
 * Keeps one bad section from taking down the operator console.
 *
 * The console reads a lot of shapes from /api/v1/admin, and the dashboard and
 * the API are deployed separately — the browser can be running a console that
 * is newer than the API answering it. When that happens a field the section
 * reads is simply absent, `undefined.toFixed(...)` throws during render, and
 * React unmounts the entire tree: the operator gets Next.js's bare
 * "Application error: a client-side exception has occurred" with no hint of
 * which section failed or why.
 *
 * That is exactly how this console broke in production. A boundary per
 * section turns that white screen into one card, with the rest of the console
 * still usable and the real reason named, so the next version skew is a
 * legible message rather than an outage.
 *
 * Resetting on `sectionId` matters: without it, switching to a healthy
 * section after a crash keeps showing the error, because a boundary that has
 * caught stays caught until its state is cleared.
 */
export class SectionBoundary extends Component<
  { sectionId: string; children: React.ReactNode },
  { message: string | null }
> {
  constructor(props: { sectionId: string; children: React.ReactNode }) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return {
      message: error instanceof Error ? error.message : 'Unknown rendering error',
    };
  }

  componentDidUpdate(prev: { sectionId: string }): void {
    if (prev.sectionId !== this.props.sectionId && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  override render(): React.ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="card alarm" role="alert">
        <h3>This section could not be displayed</h3>
        <p>
          The console asked the API for data it could not read. The most likely cause is a version
          difference: this dashboard is newer than the API answering it, so a field it expects is
          missing. The other sections are unaffected.
        </p>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
          {this.state.message}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => this.setState({ message: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
