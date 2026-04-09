import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  DEFAULT_SERVER_URL,
  generateToken,
  getServerUrl,
  getToken,
  registerToken,
  setServerUrl,
  setToken,
} from "@/lib/api";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [serverUrlInput, setServerUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Prefill from (in order of preference): existing localStorage value,
  // VITE_DEFAULT_SERVER_URL build-time env, then the current origin.
  useEffect(() => {
    setServerUrlInput(
      getServerUrl() || DEFAULT_SERVER_URL || window.location.origin,
    );
    setTokenInput(getToken());
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!serverUrlInput.trim()) {
      setError("Server URL is required");
      return;
    }
    if (tokenInput.trim().length < 16) {
      setError("Token must be at least 16 characters — tap Generate if needed");
      return;
    }
    setLoading(true);
    try {
      const cleanedUrl = serverUrlInput.trim().replace(/\/$/, "");
      await registerToken(cleanedUrl, tokenInput.trim());
      setServerUrl(cleanedUrl);
      setToken(tokenInput.trim());
      navigate({ to: "/library" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-center text-2xl font-bold">Readr</h1>
        <p className="mb-6 text-center text-sm text-gray-600">
          Sign in with a device token
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="server-url" className="mb-1 block text-xs uppercase text-gray-500">
              Server URL
            </label>
            <input
              id="server-url"
              type="url"
              placeholder="https://reader.example.com"
              value={serverUrlInput}
              onChange={(e) => setServerUrlInput(e.target.value)}
              className="w-full rounded-md border px-3 py-2"
              required
            />
          </div>

          <div>
            <label htmlFor="device-token" className="mb-1 block text-xs uppercase text-gray-500">
              Device token
            </label>
            <textarea
              id="device-token"
              placeholder="Paste an existing token or tap Generate"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full rounded-md border px-3 py-2 font-mono text-sm"
              rows={3}
              required
            />
            <button
              type="button"
              onClick={() => setTokenInput(generateToken())}
              className="mt-1 text-sm text-blue-600 hover:underline"
            >
              Generate new token
            </button>
            <p className="mt-2 text-xs text-gray-500">
              The token is a long random string stored in your browser.
              Treat it like a password — anyone who has it can read and
              write your library. Paste the same token on another device
              to share.
            </p>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {loading ? "Connecting..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
