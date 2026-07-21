import { request, requestWithSchema, type WithToken } from "./client";
import type { CaseNote, CaseReport, CaseSummary, GraphEdge, GraphNode } from "./types";
import { caseDetailResponseSchema } from "../../../../shared/schemas/caseDetail";

export function createCasesApi(withToken: WithToken) {
  return {
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
      withToken((token) =>
        requestWithSchema(`/cases/${id}?purpose=${encodeURIComponent(purpose)}`, token, caseDetailResponseSchema),
      ),

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

    getCaseReport: (caseId: string, purpose: string) =>
      withToken((token) => request<CaseReport>(`/cases/${caseId}/report?purpose=${encodeURIComponent(purpose)}`, token)),
  };
}
