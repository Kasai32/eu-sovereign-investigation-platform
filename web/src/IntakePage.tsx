import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient, type MappingTemplate } from "./lib/api";
import { useAuth } from "./lib/AuthContext";
import { ClassificationBadge } from "./components/ClassificationBadge";

// S5: data intake. Deliberate v1 scope per the blueprint — CSV upload only, no live connectors.
export function IntakePage() {
  const api = useApiClient();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes("admin");
  const canIngest = auth.roles.some((r) => ["supervisor", "compliance", "admin"].includes(r));

  const sourcesQuery = useQuery({ queryKey: ["ingestion-sources"], queryFn: () => api.listIngestionSources() });
  const templatesQuery = useQuery({ queryKey: ["ingestion-templates"], queryFn: () => api.listMappingTemplates() });
  const objectTypesQuery = useQuery({ queryKey: ["object-types"], queryFn: () => api.listObjectTypes() });
  const runsQuery = useQuery({ queryKey: ["ingestion-runs"], queryFn: () => api.listIngestionRuns() });

  const [newSourceName, setNewSourceName] = useState("");
  const createSource = useMutation({
    mutationFn: () => api.createIngestionSource({ name: newSourceName }),
    onSuccess: () => {
      setNewSourceName("");
      queryClient.invalidateQueries({ queryKey: ["ingestion-sources"] });
    },
  });

  const [templateName, setTemplateName] = useState("");
  const [templateSourceId, setTemplateSourceId] = useState("");
  const [templateTypeId, setTemplateTypeId] = useState("");
  const [matchProperty, setMatchProperty] = useState("name");
  const [mappingRows, setMappingRows] = useState<[string, string][]>([["", ""]]);
  const createTemplate = useMutation({
    mutationFn: () =>
      api.createMappingTemplate({
        sourceId: templateSourceId,
        name: templateName,
        objectTypeId: templateTypeId,
        matchProperty,
        mapping: Object.fromEntries(mappingRows.filter(([c, p]) => c && p)),
      }),
    onSuccess: () => {
      setTemplateName("");
      setMappingRows([["", ""]]);
      queryClient.invalidateQueries({ queryKey: ["ingestion-templates"] });
    },
  });

  const [uploadSourceId, setUploadSourceId] = useState("");
  const [uploadTemplateId, setUploadTemplateId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const runIngestion = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("choose a file first");
      return api.runIngestion(uploadSourceId, uploadTemplateId, file);
    },
    onSuccess: () => {
      setFile(null);
      queryClient.invalidateQueries({ queryKey: ["ingestion-runs"] });
    },
  });

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const runErrorsQuery = useQuery({
    queryKey: ["run-errors", expandedRunId],
    queryFn: () => api.getRunErrors(expandedRunId!),
    enabled: !!expandedRunId,
  });

  function downloadErrorsCsv() {
    if (!runErrorsQuery.data) return;
    const errors = runErrorsQuery.data.errors;
    const columns = Array.from(new Set(errors.flatMap((e) => Object.keys(e.raw_row))));
    const header = [...columns, "error_message"].join(",");
    const lines = errors.map((e) => [...columns.map((c) => JSON.stringify(e.raw_row[c] ?? "")), JSON.stringify(e.error_message)].join(","));
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ingestion-errors-${expandedRunId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const templatesForUploadSource = (templatesQuery.data?.templates ?? []).filter((t) => t.source_id === uploadSourceId);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <h1 className="text-xl font-semibold text-slate-900">Data intake</h1>

      {/* Upload */}
      {canIngest && (
        <section className="rounded border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Upload CSV</h2>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              Source
              <select
                value={uploadSourceId}
                onChange={(e) => {
                  setUploadSourceId(e.target.value);
                  setUploadTemplateId("");
                }}
                className="block rounded border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="">Select…</option>
                {sourcesQuery.data?.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              Template
              <select
                value={uploadTemplateId}
                onChange={(e) => setUploadTemplateId(e.target.value)}
                className="block rounded border border-slate-300 px-2 py-1 text-sm"
                disabled={!uploadSourceId}
              >
                <option value="">Select…</option>
                {templatesForUploadSource.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <button
              onClick={() => runIngestion.mutate()}
              disabled={!file || !uploadSourceId || !uploadTemplateId || runIngestion.isPending}
              className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {runIngestion.isPending ? "Ingesting…" : "Ingest"}
            </button>
          </div>
          {runIngestion.isError && (
            <p className="mt-2 text-sm text-red-600">{(runIngestion.error as Error).message}</p>
          )}
          {runIngestion.isSuccess && (
            <p className="mt-2 text-sm text-emerald-700">
              Run complete: {runIngestion.data.records_ingested} ingested, {runIngestion.data.records_auto_merged} auto-merged,{" "}
              {runIngestion.data.records_queued_for_review} queued for review, {runIngestion.data.records_quarantined} quarantined.
            </p>
          )}
        </section>
      )}

      {/* Runs */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Ingestion runs</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-1.5 pr-4 font-medium">File</th>
              <th className="py-1.5 pr-4 font-medium">Status</th>
              <th className="py-1.5 pr-4 font-medium">Total</th>
              <th className="py-1.5 pr-4 font-medium">Ingested</th>
              <th className="py-1.5 pr-4 font-medium">Auto-merged</th>
              <th className="py-1.5 pr-4 font-medium">Queued</th>
              <th className="py-1.5 pr-4 font-medium">Quarantined</th>
              <th className="py-1.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {runsQuery.data?.runs.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-4">{r.filename}</td>
                <td className="py-1.5 pr-4">{r.status}</td>
                <td className="py-1.5 pr-4">{r.records_total}</td>
                <td className="py-1.5 pr-4">{r.records_ingested}</td>
                <td className="py-1.5 pr-4">{r.records_auto_merged}</td>
                <td className="py-1.5 pr-4">{r.records_queued_for_review}</td>
                <td className="py-1.5 pr-4">{r.records_quarantined}</td>
                <td className="py-1.5">
                  {r.records_quarantined > 0 && (
                    <button
                      onClick={() => setExpandedRunId(expandedRunId === r.id ? null : r.id)}
                      className="text-xs text-slate-500 underline"
                    >
                      {expandedRunId === r.id ? "hide errors" : "view errors"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(runsQuery.data?.runs.length ?? 0) === 0 && (
              <tr>
                <td colSpan={8} className="py-4 text-center text-slate-400">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {expandedRunId && runErrorsQuery.data && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-amber-800">Quarantined rows</h3>
              <button onClick={downloadErrorsCsv} className="text-xs text-amber-800 underline">
                download CSV
              </button>
            </div>
            <ul className="space-y-1 text-xs text-amber-900">
              {runErrorsQuery.data.errors.map((e) => (
                <li key={e.row_number}>
                  row {e.row_number}: {e.error_message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Sources */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Sources</h2>
        <ul className="mb-3 space-y-1 text-sm">
          {sourcesQuery.data?.sources.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span>{s.name}</span>
              <ClassificationBadge classification={s.default_classification} />
              {s.retention_days && <span className="text-xs text-slate-400">retain {s.retention_days}d</span>}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newSourceName.trim()) createSource.mutate();
            }}
            className="flex gap-2"
          >
            <input
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              placeholder="New source name"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <button type="submit" className="rounded bg-slate-100 px-3 py-1 text-sm hover:bg-slate-200">
              Add source
            </button>
          </form>
        )}
      </section>

      {/* Templates */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Column mapping templates</h2>
        <ul className="mb-3 space-y-1 text-sm">
          {templatesQuery.data?.templates.map((t: MappingTemplate) => (
            <li key={t.id}>
              {t.name} — match on <code className="text-xs">{t.match_property}</code>,{" "}
              {Object.keys(t.mapping).length} columns mapped
            </li>
          ))}
        </ul>
        {isAdmin && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (templateName.trim() && templateSourceId && templateTypeId) createTemplate.mutate();
            }}
            className="space-y-2"
          >
            <div className="flex flex-wrap gap-2">
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Template name"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
              <select value={templateSourceId} onChange={(e) => setTemplateSourceId(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                <option value="">Source…</option>
                {sourcesQuery.data?.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select value={templateTypeId} onChange={(e) => setTemplateTypeId(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                <option value="">Object type…</option>
                {objectTypesQuery.data?.objectTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                value={matchProperty}
                onChange={(e) => setMatchProperty(e.target.value)}
                placeholder="match property (e.g. name)"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div className="space-y-1">
              {mappingRows.map(([col, prop], i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={col}
                    onChange={(e) => {
                      const next = [...mappingRows];
                      next[i] = [e.target.value, next[i][1]];
                      setMappingRows(next);
                    }}
                    placeholder="CSV column"
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                  <span className="self-center text-xs text-slate-400">→</span>
                  <input
                    value={prop}
                    onChange={(e) => {
                      const next = [...mappingRows];
                      next[i] = [next[i][0], e.target.value];
                      setMappingRows(next);
                    }}
                    placeholder="property key"
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setMappingRows([...mappingRows, ["", ""]])}
                className="text-xs text-slate-500 underline"
              >
                + add column mapping
              </button>
            </div>
            <button type="submit" className="rounded bg-slate-100 px-3 py-1 text-sm hover:bg-slate-200">
              Save template
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
