import { useMemo } from "react";
import { useAuth } from "./AuthContext";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ObjectSummary = {
  id: string;
  object_type: string;
  properties: Record<string, unknown>;
  classification: "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED";
  created_at: string;
};

export type PropertyMeta = {
  property_key: string;
  source: string;
  confidence: number | null;
  classification: string;
  ingested_at: string;
  raw_source_ref: string | null;
};

export type Neighbor = {
  edge_id: string;
  relationship: string;
  edge_properties: Record<string, unknown>;
  edge_classification: string;
  neighbor_id: string;
  direction: "incoming" | "outgoing";
};

export type ObjectDetail = {
  object: ObjectSummary & { canonical_of: string | null };
  propertyMeta: PropertyMeta[];
  neighbors: Neighbor[];
};

export type CaseSummary = {
  id: string;
  title: string;
  status: "open" | "under_review" | "closed" | "archived";
  priority: string;
  classification: string;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  entity_count: number;
};

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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

export function useApiClient() {
  const { getValidAccessToken } = useAuth();

  return useMemo(() => {
    async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
      const token = await getValidAccessToken();
      if (!token) throw new ApiError(401, "not authenticated");
      return fn(token);
    }

    return {
      listObjects: (params: { q?: string; type?: string } = {}) =>
        withToken((token) => {
          const search = new URLSearchParams();
          if (params.q) search.set("q", params.q);
          if (params.type) search.set("type", params.type);
          const qs = search.toString();
          return request<{ objects: ObjectSummary[] }>(`/objects${qs ? `?${qs}` : ""}`, token);
        }),

      getObject: (id: string, purpose: string) =>
        withToken((token) =>
          request<ObjectDetail>(`/objects/${id}?purpose=${encodeURIComponent(purpose)}`, token),
        ),

      listCases: (params: { status?: string } = {}) =>
        withToken((token) => {
          const search = new URLSearchParams();
          if (params.status) search.set("status", params.status);
          const qs = search.toString();
          return request<{ cases: CaseSummary[] }>(`/cases${qs ? `?${qs}` : ""}`, token);
        }),

      createCase: (body: { title: string; classification?: string; priority?: string; purpose?: string }) =>
        withToken((token) =>
          request<CaseSummary>("/cases", token, { method: "POST", body: JSON.stringify(body) }),
        ),
    };
  }, [getValidAccessToken]);
}
