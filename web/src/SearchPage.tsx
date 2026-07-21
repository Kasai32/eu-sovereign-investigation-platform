import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useApiClient } from "./lib/api";
import { ClassificationBadge } from "./components/ClassificationBadge";

// S3: object search / explorer
export function SearchPage() {
  const api = useApiClient();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["objects", submittedQ, type],
    queryFn: () => api.listObjects({ q: submittedQ || undefined, type: type || undefined }),
  });

  // Fetched, not hardcoded: object types are data (per the ontology design), so a new type
  // added via ingestion templates shows up here without a frontend deploy. Was a hardcoded
  // constant in Phase 2 — see PHASE2_REVIEW.md.
  const objectTypesQuery = useQuery({ queryKey: ["object-types"], queryFn: () => api.listObjectTypes() });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Search</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedQ(q);
        }}
        className="mb-4 flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name…"
          className="w-64 rounded border border-slate-300 px-3 py-1.5 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value="">All types</option>
          {objectTypesQuery.data?.objectTypes.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700">
          Search
        </button>
      </form>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}

      {data && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 font-medium">Classification</th>
              <th className="py-2 pr-4 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.objects.map((o) => (
              <tr key={o.id} className="border-b border-slate-100 hover:bg-white">
                <td className="py-2 pr-4">
                  <Link to="/objects/$id" params={{ id: o.id }} className="text-slate-900 hover:underline">
                    {(o.properties.name as string) ?? o.id}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-slate-600">{o.object_type}</td>
                <td className="py-2 pr-4">
                  <ClassificationBadge classification={o.classification} />
                </td>
                <td className="py-2 pr-4 text-slate-500">{new Date(o.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.objects.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-400">
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
