import { request, type WithToken } from "./client";
import type { EdgeMappingTemplate, IngestionRun, IngestionRunError, IngestionSource, MappingTemplate } from "./types";

export function createIngestionApi(withToken: WithToken) {
  return {
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

    // Edge-mapping templates: ingest a CSV as edges between existing objects (e.g. a
    // transactions file) instead of new objects. See DECISIONS.md #16/#45.
    listEdgeTemplates: (sourceId?: string) =>
      withToken((token) => {
        const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "";
        return request<{ templates: EdgeMappingTemplate[] }>(`/ingestion/edge-templates${qs}`, token);
      }),

    createEdgeTemplate: (body: {
      sourceId: string;
      name: string;
      relationshipTypeId: string;
      sourceObjectTypeId: string;
      sourceMatchColumn: string;
      sourceMatchProperty: string;
      targetObjectTypeId: string;
      targetMatchColumn: string;
      targetMatchProperty: string;
      propertyMapping?: Record<string, string>;
      defaultClassification?: string;
    }) =>
      withToken((token) =>
        request<EdgeMappingTemplate>("/ingestion/edge-templates", token, { method: "POST", body: JSON.stringify(body) }),
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

    runEdgeIngestion: (sourceId: string, edgeTemplateId: string, file: File) =>
      withToken((token) => {
        const form = new FormData();
        form.set("sourceId", sourceId);
        form.set("edgeTemplateId", edgeTemplateId);
        form.set("file", file);
        return request<IngestionRun>("/ingestion/runs", token, { method: "POST", body: form });
      }),
  };
}
