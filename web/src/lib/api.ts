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

export type CaseEntity = {
  object_id: string;
  object_type: string;
  properties: Record<string, unknown>;
  classification: string;
  pinned_by: string;
  pinned_at: string;
};

export type CaseNote = { id: string; body: string; author_id: string; author_name: string; created_at: string };
export type CaseActivity = {
  id: string;
  action: string;
  details: Record<string, unknown>;
  actor_id: string;
  actor_name: string;
  occurred_at: string;
};
export type CaseMember = { user_id: string; display_name: string; role: string };

export type CaseDetail = {
  case: CaseSummary & { evidence_snapshot: unknown; closed_at: string | null };
  entities: CaseEntity[];
  notes: CaseNote[];
  activity: CaseActivity[];
  members: CaseMember[];
};

export type GraphNode = { id: string; object_type: string; properties: Record<string, unknown>; classification: string };
export type GraphEdge = {
  id: string;
  source_object_id: string;
  target_object_id: string;
  relationship: string;
  properties: Record<string, unknown>;
  classification: string;
};

export type ExpandResult = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; requestedHops: number };
export type PathResult =
  | { found: false; nodes: []; edges: [] }
  | { found: true; path: string[]; hops: number; nodes: GraphNode[]; edges: GraphEdge[] };

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

      getCase: (id: string, purpose: string) =>
        withToken((token) => request<CaseDetail>(`/cases/${id}?purpose=${encodeURIComponent(purpose)}`, token)),

      getCaseGraph: (id: string) =>
        withToken((token) => request<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/cases/${id}/graph`, token)),

      addNote: (caseId: string, body: string, purpose?: string) =>
        withToken((token) =>
          request<CaseNote>(`/cases/${caseId}/notes`, token, {
            method: "POST",
            body: JSON.stringify({ body, purpose }),
          }),
        ),

      pinEntity: (caseId: string, objectId: string, purpose?: string) =>
        withToken((token) =>
          request<{ ok: true }>(`/cases/${caseId}/entities`, token, {
            method: "POST",
            body: JSON.stringify({ objectId, purpose }),
          }),
        ),

      unpinEntity: (caseId: string, objectId: string, purpose?: string) =>
        withToken((token) => {
          const qs = purpose ? `?purpose=${encodeURIComponent(purpose)}` : "";
          return request<{ ok: true }>(`/cases/${caseId}/entities/${objectId}${qs}`, token, { method: "DELETE" });
        }),

      setCaseStatus: (caseId: string, status: string, purpose: string) =>
        withToken((token) =>
          request(`/cases/${caseId}/status`, token, { method: "PATCH", body: JSON.stringify({ status, purpose }) }),
        ),

      expandGraph: (nodeId: string, hops: number, purpose?: string) =>
        withToken((token) => {
          const search = new URLSearchParams({ nodeId, hops: String(hops) });
          if (purpose) search.set("purpose", purpose);
          return request<ExpandResult>(`/graph/expand?${search.toString()}`, token);
        }),

      findPath: (from: string, to: string, purpose?: string) =>
        withToken((token) => {
          const search = new URLSearchParams({ from, to });
          if (purpose) search.set("purpose", purpose);
          return request<PathResult>(`/graph/path?${search.toString()}`, token);
        }),
    };
  }, [getValidAccessToken]);
}
