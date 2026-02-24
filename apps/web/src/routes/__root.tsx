import { createRootRouteWithContext, Outlet, Link } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="border-b bg-white px-6 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link to="/" className="text-xl font-bold text-gray-900">
            Readr
          </Link>
          <div className="flex gap-4">
            <Link
              to="/library"
              className="text-gray-600 hover:text-gray-900 [&.active]:font-semibold [&.active]:text-gray-900"
            >
              Library
            </Link>
            <Link
              to="/upload"
              className="text-gray-600 hover:text-gray-900 [&.active]:font-semibold [&.active]:text-gray-900"
            >
              Upload
            </Link>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
