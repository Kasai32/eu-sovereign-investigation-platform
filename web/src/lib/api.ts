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

export type ObjectType = {
  id: string;
  name: string;
  property_schema: { type?: string; required?: string[]; properties?: Record<string, { type?: string; format?: string }> };
  version: number;
};

export type IngestionSource = {
  id: string;
  name: string;
  default_classification: string;
  retention_days: number | null;
  created_at: string;
};

export type MappingTemplate = {
  id: string;
  source_id: string;
  name: string;
  object_type_id: string;
  match_property: string;
  mapping: Record<string, string>;
  created_at: string;
};

export type IngestionRun = {
  id: string;
  source_id: string;
  template_id: string;
  source_name: string;
  template_name: string;
  filename: string;
  status: "pending" | "running" | "completed" | "completed_with_errors" | "failed";
  records_total: number;
  records_ingested: number;
  records_quarantined: number;
  records_auto_merged: number;
  records_queued_for_review: number;
  started_at: string;
  completed_at: string | null;
};

export type IngestionRunError = { row_number: number; raw_row: Record<string, string>; error_message: string; created_at: string };

export type ResolutionQueueItem = {
  id: string;
  similarity_score: number;
  decision: "pending" | "merged" | "not_a_match" | "skipped";
  objectA: ObjectSummary;
  objectB: ObjectSummary;
  neighborsA: { relationship: string; neighbor_id: string; neighbor_type: string }[];
  neighborsB: { relationship: string; neighbor_id: string; neighbor_type: string }[];
};

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
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

      listObjectTypes: () => withToken((token) => request<{ objectTypes: ObjectType[] }>("/object-types", token)),

      listIngestionSources: () => withToken((token) => request<{ sources: IngestionSource[] }>("/ingestion/sources", token)),

      createIngestionSource: (body: { name: string; defaultClassification?: string; retentionDays?: number }) =>
        withToken((token) =>
          request<IngestionSource>("/ingestion/sources", token, { method: "POST", body: JSON.stringify(body) }),
        ),

      listMappingTemplates: (sourceId?: string) =>
        withToken((token) => {
          const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "";
          return request<{ templates: MappingTemplate[] }>(`/ingestion/templates${qs}`, token);
        }),

      createMappingTemplate: (body: {
        sourceId: string;
        name: string;
        objectTypeId: string;
        matchProperty: string;
        mapping: Record<string, string>;
      }) =>
        withToken((token) =>
          request<MappingTemplate>("/ingestion/templates", token, { method: "POST", body: JSON.stringify(body) }),
        ),

      listIngestionRuns: () => withToken((token) => request<{ runs: IngestionRun[] }>("/ingestion/runs", token)),

      getRunErrors: (runId: string) =>
        withToken((token) => request<{ errors: IngestionRunError[] }>(`/ingestion/runs/${runId}/errors`, token)),

      runIngestion: (sourceId: string, templateId: string, file: File) =>
        withToken((token) => {
          const form = new FormData();
          form.set("sourceId", sourceId);
          form.set("templateId", templateId);
          form.set("file", file);
          return request<IngestionRun>("/ingestion/runs", token, { method: "POST", body: form });
        }),

      listResolutionQueue: (status: string = "pending") =>
        withToken((token) => request<{ items: ResolutionQueueItem[] }>(`/resolution-queue?status=${status}`, token)),

      decideResolution: (id: string, decision: "merged" | "not_a_match" | "skipped", purpose?: string) =>
        withToken((token) =>
          request<{ ok: true }>(`/resolution-queue/${id}/decide`, token, {
            method: "POST",
            body: JSON.stringify({ decision, purpose }),
          }),
        ),

      undoResolution: (id: string, purpose?: string) =>
        withToken((token) =>
          request<{ ok: true }>(`/resolution-queue/${id}/undo`, token, { method: "POST", body: JSON.stringify({ purpose }) }),
        ),
    };
  }, [getValidAccessToken]);
}
