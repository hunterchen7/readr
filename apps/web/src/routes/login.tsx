import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  DEFAULT_SERVER_URL,
  emailLoginStart,
  emailLoginVerify,
  getServerUrl,
  setServerUrl,
  setToken,
} from "@/lib/api";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

type Step = "email" | "code";

function LoginPage() {
  const navigate = useNavigate();
  const [serverUrlInput, setServerUrlInput] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setServerUrlInput(
      getServerUrl() || DEFAULT_SERVER_URL || window.location.origin,
    );
  }, []);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!serverUrlInput.trim()) { setError("Server URL is required"); return; }
    if (!email.trim() || !email.includes("@")) { setError("Valid email required"); return; }

    setError("");
    setLoading(true);
    try {
      const cleanedUrl = serverUrlInput.trim().replace(/\/$/, "");
      setServerUrl(cleanedUrl);
      await emailLoginStart(email.trim().toLowerCase());
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length !== 6) { setError("Enter the 6-digit code"); return; }

    setError("");
    setLoading(true);
    try {
      const token = await emailLoginVerify(email.trim().toLowerCase(), code.trim());
      setToken(token);
      navigate({ to: "/library" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-center text-2xl font-bold">Readr</h1>
        <p className="mb-6 text-center text-sm text-gray-600">
          {step === "email" ? "Sign in with your email" : "Enter verification code"}
        </p>

        {step === "email" ? (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label htmlFor="server-url" className="mb-1 block text-xs uppercase text-gray-500">
                Server URL
              </label>
              <input
                id="server-url"
                type="url"
                placeholder="https://readr.example.com"
                value={serverUrlInput}
                onChange={(e) => setServerUrlInput(e.target.value)}
                className="w-full rounded-md border px-3 py-2"
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="mb-1 block text-xs uppercase text-gray-500">
                Email
              </label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border px-3 py-2"
                required
                autoFocus
              />
            </div>

            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyCode} className="space-y-4">
            <p className="text-sm text-gray-600">
              We sent a 6-digit code to <strong>{email.trim().toLowerCase()}</strong>
            </p>

            <div>
              <label htmlFor="code" className="mb-1 block text-xs uppercase text-gray-500">
                Verification code
              </label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-center text-2xl font-semibold tracking-widest"
                required
                autoFocus
              />
            </div>

            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>

            <button
              type="button"
              onClick={() => { setStep("email"); setCode(""); setError(""); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              ← Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
