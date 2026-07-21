import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce";

const KEYCLOAK_URL = import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080";
const REALM = "platform";
const CLIENT_ID = "platform-api";
const REDIRECT_URI = `${window.location.origin}/auth/callback`;

const ISSUER = `${KEYCLOAK_URL}/realms/${REALM}`;

const STORAGE_KEYS = {
  accessToken: "auth.access_token",
  refreshToken: "auth.refresh_token",
  expiresAt: "auth.expires_at",
  pkceVerifier: "auth.pkce_verifier",
  pkceState: "auth.pkce_state",
} as const;

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: number };

// sessionStorage, not a real secure-storage mechanism: acceptable for local dev, but this is
// the honest limitation — an XSS bug in this SPA could exfiltrate the token. A production
// deployment should move to a backend-for-frontend with httpOnly session cookies instead.
// Flagged explicitly in PHASE2_REVIEW.md rather than left silent.
export function getStoredTokens(): TokenSet | null {
  const accessToken = sessionStorage.getItem(STORAGE_KEYS.accessToken);
  const refreshToken = sessionStorage.getItem(STORAGE_KEYS.refreshToken);
  const expiresAt = sessionStorage.getItem(STORAGE_KEYS.expiresAt);
  if (!accessToken || !refreshToken || !expiresAt) return null;
  return { accessToken, refreshToken, expiresAt: Number(expiresAt) };
}

function storeTokens(tokens: { access_token: string; refresh_token: string; expires_in: number }): TokenSet {
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  sessionStorage.setItem(STORAGE_KEYS.accessToken, tokens.access_token);
  sessionStorage.setItem(STORAGE_KEYS.refreshToken, tokens.refresh_token);
  sessionStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt };
}

export function clearTokens(): void {
  sessionStorage.removeItem(STORAGE_KEYS.accessToken);
  sessionStorage.removeItem(STORAGE_KEYS.refreshToken);
  sessionStorage.removeItem(STORAGE_KEYS.expiresAt);
}

export async function startLogin(): Promise<void> {
  const verifier = generateCodeVerifier();
  const state = generateState();
  const challenge = await generateCodeChallenge(verifier);
  sessionStorage.setItem(STORAGE_KEYS.pkceVerifier, verifier);
  sessionStorage.setItem(STORAGE_KEYS.pkceState, state);

  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

export async function handleCallback(params: URLSearchParams): Promise<void> {
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = sessionStorage.getItem(STORAGE_KEYS.pkceState);
  const verifier = sessionStorage.getItem(STORAGE_KEYS.pkceVerifier);

  if (!code || !state || !verifier || state !== expectedState) {
    throw new Error("invalid OIDC callback (missing code/state or state mismatch)");
  }
  sessionStorage.removeItem(STORAGE_KEYS.pkceState);
  sessionStorage.removeItem(STORAGE_KEYS.pkceVerifier);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  storeTokens(await res.json());
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return storeTokens(await res.json());
}

export function logout(): void {
  clearTokens();
  const url = new URL(`${ISSUER}/protocol/openid-connect/logout`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("post_logout_redirect_uri", window.location.origin);
  window.location.assign(url.toString());
}

// Decoded for display only (name, email) — never trusted for authorization decisions. The API
// re-derives role/clearance from app_users on every request regardless of what a token claims.
export function decodeDisplayClaims(accessToken: string): { name?: string; email?: string; roles: string[] } {
  const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return {
    name: payload.name,
    email: payload.email,
    roles: (payload.realm_access?.roles as string[] | undefined) ?? [],
  };
}
