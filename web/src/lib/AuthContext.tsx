import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { decodeDisplayClaims, getStoredTokens, logout as doLogout, refreshTokens, startLogin, type TokenSet } from "./auth";

type AuthState = {
  tokens: TokenSet | null;
  displayName?: string;
  email?: string;
  roles: string[];
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  getValidAccessToken: () => Promise<string | null>;
};

const AuthContext = createContext<AuthState | null>(null);

// Refresh a bit before actual expiry so an in-flight request never races the token's real
// expiry moment.
const REFRESH_SKEW_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<TokenSet | null>(() => getStoredTokens());
  const [isLoading, setIsLoading] = useState(false);

  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    const current = getStoredTokens();
    if (!current) return null;
    if (Date.now() < current.expiresAt - REFRESH_SKEW_MS) return current.accessToken;
    try {
      const refreshed = await refreshTokens(current.refreshToken);
      setTokens(refreshed);
      return refreshed.accessToken;
    } catch {
      setTokens(null);
      return null;
    }
  }, []);

  // On mount, if we have a token that's already past skew, refresh eagerly so the UI doesn't
  // render as logged-out for a moment before silently recovering.
  useEffect(() => {
    if (!tokens) return;
    if (Date.now() >= tokens.expiresAt - REFRESH_SKEW_MS) {
      setIsLoading(true);
      getValidAccessToken().finally(() => setIsLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const claims = tokens ? decodeDisplayClaims(tokens.accessToken) : null;

  const value = useMemo<AuthState>(
    () => ({
      tokens,
      displayName: claims?.name,
      email: claims?.email,
      roles: claims?.roles ?? [],
      isLoading,
      login: () => void startLogin(),
      logout: () => doLogout(),
      getValidAccessToken,
    }),
    [tokens, isLoading, getValidAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
