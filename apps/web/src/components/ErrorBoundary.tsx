import { Component, type ReactNode } from "react";

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-8">
          <p className="text-red-600">Something went wrong</p>
          <p className="text-sm text-gray-500">{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })} className="rounded-md border px-3 py-1 text-sm text-gray-600 hover:bg-gray-50">Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
