import { Component, type ErrorInfo, type ReactNode } from "react";

// Top-level render guard. A throw anywhere in the wrapped subtree used to
// white-screen the whole SPA (React unmounts the entire tree when a render
// error is uncaught). This boundary catches it, logs it, and paints a
// friendly Chinese fallback with a 重试 / 刷新 affordance so the user isn't
// stranded on a blank page.
//
// Two layers wire this up in App.tsx:
//   1. an outer boundary around <AppRoutes/> (last line of defense), and
//   2. an inner boundary keyed on the route path around the route outlet, so
//      a single page crashing doesn't take the app shell (rail/header) with
//      it — and navigating to a different route auto-resets the boundary
//      (React remounts it when `resetKey` changes).

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this value changes, the boundary remounts and clears its error
   *  state — used to auto-recover the route-level boundary on navigation. */
  resetKey?: unknown;
  /** Optional override for the fallback UI. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Genuine error logging — keep it even in production so a white-screen
    // root cause is still recoverable from the console / error reporting.
    console.error("[ErrorBoundary] render error", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    // A navigation (resetKey change) clears the captured error so the new
    // route renders instead of the stale fallback.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-10 text-center"
        >
          <div className="text-5xl">😵</div>
          <h1 className="text-xl font-semibold text-fg">页面出错了</h1>
          <p className="max-w-sm text-sm text-muted">
            抱歉，页面遇到了一点小问题。你可以重试，或刷新页面后再试一次。
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-lg border border-line bg-white px-4 py-1.5 text-sm transition hover:bg-blue-50 hover:text-primary"
            >
              重试
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-fg shadow-sm transition hover:bg-primary/90"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
