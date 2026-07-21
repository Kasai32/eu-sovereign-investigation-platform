import { useEffect, useState } from "react";
import { handleCallback } from "./lib/auth";

// /auth/callback — completes the PKCE exchange, then a hard reload so AuthProvider re-reads
// tokens from sessionStorage on mount rather than needing a state bridge.
export function AuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    handleCallback(new URLSearchParams(window.location.search))
      .then(() => window.location.assign("/"))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  return (
    <div className="flex h-screen items-center justify-center text-sm text-slate-500">
      {error ? `Sign-in failed: ${error}` : "Signing in…"}
    </div>
  );
}
