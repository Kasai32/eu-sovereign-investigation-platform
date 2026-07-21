import type { z } from "zod";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  // FormData bodies (CSV upload) must NOT get an explicit Content-Type — the browser sets the
  // multipart boundary itself. JSON bodies do.
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// PRD v1.1 N5: request<T>() above is a bare type assertion — nothing actually checks the
// response matches T, so a shape change on the API surfaces as a silent `undefined` at
// whatever field moved, not a build failure. This validates against the same Zod schema the
// API validates its own response against (shared/schemas/*.ts) instead — a mismatch throws
// here, loudly, rather than downstream wherever the missing field happens to get read.
export async function requestWithSchema<S extends z.ZodType>(
  path: string,
  token: string,
  schema: S,
  init?: RequestInit,
): Promise<z.infer<S>> {
  const json = await request<unknown>(path, token, init);
  return schema.parse(json);
}

// Every per-domain module (objects.ts, cases.ts, ...) takes a WithToken and builds its methods
// on top of it — the same getValidAccessToken-backed closure `useApiClient()` creates once and
// passes to each, so every request goes through the identical token-refresh path.
export type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;
