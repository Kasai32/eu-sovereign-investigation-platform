import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useApiClient, type CaseSummary } from "./lib/api";
import { ClassificationBadge } from "./components/ClassificationBadge";

// S1: case queue
export function CasesPage() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["cases", status],
    queryFn: () => api.listCases({ status: status || undefined }),
  });

  const createCase = useMutation({
    mutationFn: () => api.createCase({ title, purpose: "new case opened from queue" }),
    onSuccess: () => {
      setTitle("");
      setShowCreate(false);
      queryClient.invalidateQueries({ queryKey: ["cases"] });
    },
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Cases</h1>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          New case
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) createCase.mutate();
          }}
          className="mb-4 flex gap-2 rounded border border-slate-200 bg-white p-3"
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Case title"
            className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
            autoFocus
          />
          <button
            type="submit"
            disabled={createCase.isPending}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {createCase.isPending ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      <div className="mb-4 flex gap-2">
        {["", "open", "under_review", "closed", "archived"].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded px-3 py-1 text-xs ${status === s ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200"}`}
          >
            {s || "all"}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}

      {data && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Title</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Priority</th>
              <th className="py-2 pr-4 font-medium">Classification</th>
              <th className="py-2 pr-4 font-medium">Entities</th>
            </tr>
          </thead>
          <tbody>
            {data.cases.map((c: CaseSummary) => (
              <tr key={c.id} className="border-b border-slate-100">
                <td className="py-2 pr-4">
                  <Link to="/cases/$id" params={{ id: c.id }} className="text-slate-900 hover:underline">
                    {c.title}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-slate-600">{c.status}</td>
                <td className="py-2 pr-4 text-slate-600">{c.priority}</td>
                <td className="py-2 pr-4">
                  <ClassificationBadge classification={c.classification} />
                </td>
                <td className="py-2 pr-4 text-slate-500">{c.entity_count}</td>
              </tr>
            ))}
            {data.cases.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-400">
                  No cases.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
