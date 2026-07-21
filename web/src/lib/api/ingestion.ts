import { request, type WithToken } from "./client";
import type { IngestionRun, IngestionRunError, IngestionSource, MappingTemplate } from "./types";

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
  };
}
