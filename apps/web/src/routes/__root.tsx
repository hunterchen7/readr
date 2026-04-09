import { createRootRouteWithContext, Outlet, Link, useLocation } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";
  const isAuthed = !!getToken();

  return (
    <div className="min-h-screen bg-gray-50">
      {!isLoginPage && isAuthed ? (
        <nav aria-label="Main navigation" className="border-b bg-white px-6 py-3">
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
      ) : null}
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
