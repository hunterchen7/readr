import { createRootRouteWithContext, Outlet, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { getToken, getServerUrl, clearAuth } from "@/lib/api";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isLoginPage = location.pathname === "/login";
  const isReaderPage = location.pathname.startsWith("/reader/");
  const isAuthed = !!getToken();
  const [menuOpen, setMenuOpen] = useState(false);

  function handleSignOut() {
    clearAuth();
    setMenuOpen(false);
    navigate({ to: "/login" });
  }

  // Reader page gets no chrome — full screen
  if (isReaderPage && isAuthed) {
    return <Outlet />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {!isLoginPage && isAuthed ? (
        <nav aria-label="Main navigation" className="border-b bg-white px-6 py-3">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <Link to="/" className="text-xl font-bold text-gray-900">
              Readr
            </Link>
            <div className="flex items-center gap-4">
              <Link
                to="/library"
                className="text-sm text-gray-600 hover:text-gray-900 sm:text-base [&.active]:font-semibold [&.active]:text-gray-900"
              >
                Library
              </Link>
              <Link
                to="/upload"
                className="text-sm text-gray-600 hover:text-gray-900 sm:text-base [&.active]:font-semibold [&.active]:text-gray-900"
              >
                Upload
              </Link>
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-full bg-gray-200 py-1 pl-3 pr-1 text-sm text-gray-600 hover:bg-gray-300 sm:pl-3 sm:pr-2"
                  aria-label="User menu"
                >
                  <span className="hidden max-w-[120px] truncate text-xs text-gray-500 sm:inline">
                    {getServerUrl()?.replace(/^https?:\/\//, "") ?? ""}
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-300 text-xs font-medium">
                    U
                  </span>
                </button>
                {menuOpen ? (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border bg-white py-1 shadow-lg">
                      <div className="border-b px-4 py-2">
                        <p className="truncate text-xs text-gray-400">
                          {getServerUrl()}
                        </p>
                      </div>
                      <button
                        onClick={handleSignOut}
                        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-50"
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </nav>
      ) : null}
      <main className={isLoginPage ? "" : "mx-auto max-w-6xl px-6 py-8"}>
        <Outlet />
      </main>
    </div>
  );
}
