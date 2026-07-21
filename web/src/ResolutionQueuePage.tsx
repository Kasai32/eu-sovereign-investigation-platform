import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient, type ResolutionQueueItem } from "./lib/api";
import { ClassificationBadge } from "./components/ClassificationBadge";

function displayLabel(props: Record<string, unknown>, fallback: string): string {
  return (props.name as string) ?? (props.account_number as string) ?? fallback;
}

function ComparisonCard({ item }: { item: ResolutionQueueItem }) {
  const allKeys = Array.from(new Set([...Object.keys(item.objectA.properties), ...Object.keys(item.objectB.properties)]));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="w-28 py-1 font-medium">property</th>
          <th className="py-1 font-medium">{displayLabel(item.objectA.properties, item.objectA.object_type)} (existing)</th>
          <th className="py-1 font-medium">{displayLabel(item.objectB.properties, item.objectB.object_type)} (new)</th>
        </tr>
      </thead>
      <tbody>
        {allKeys.map((key) => {
          const a = item.objectA.properties[key];
          const b = item.objectB.properties[key];
          const mismatch = a !== undefined && b !== undefined && a !== b;
          return (
            <tr key={key} className="border-t border-slate-100">
              <td className="py-1 font-medium text-slate-500">{key}</td>
              <td className={`py-1 ${mismatch ? "bg-amber-50" : ""}`}>{a !== undefined ? String(a) : "—"}</td>
              <td className={`py-1 ${mismatch ? "bg-amber-50" : ""}`}>{b !== undefined ? String(b) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function NeighborhoodList({ label, neighbors }: { label: string; neighbors: ResolutionQueueItem["neighborsA"] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>
      {neighbors.length === 0 && <div className="text-xs text-slate-400">no connections</div>}
      <ul className="space-y-0.5 text-xs text-slate-600">
        {neighbors.map((n, i) => (
          <li key={i}>
            {n.relationship} → {n.neighbor_type} ({n.neighbor_id.slice(0, 8)}…)
          </li>
        ))}
      </ul>
    </div>
  );
}

// S6: entity resolution review queue. Keyboard-driven per the blueprint ("reviewers process
// dozens at a sitting"): m = merge, n = not a match, s = skip, on the focused pair.
export function ResolutionQueuePage() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [focusedIndex, setFocusedIndex] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["resolution-queue"],
    queryFn: () => api.listResolutionQueue("pending"),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "merged" | "not_a_match" | "skipped" }) =>
      api.decideResolution(id, decision, `entity resolution reviewed: ${decision}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resolution-queue"] });
      setFocusedIndex((i) => Math.max(0, i - 1));
    },
  });

  const items = data?.items ?? [];
  const focused = items[focusedIndex];

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused || decide.isPending) return;
      if (e.key === "m") decide.mutate({ id: focused.id, decision: "merged" });
      else if (e.key === "n") decide.mutate({ id: focused.id, decision: "not_a_match" });
      else if (e.key === "s") decide.mutate({ id: focused.id, decision: "skipped" });
      else if (e.key === "ArrowDown") setFocusedIndex((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "ArrowUp") setFocusedIndex((i) => Math.max(0, i - 1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, decide, items.length]);

  if (isLoading) return <p className="mx-auto max-w-5xl text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="mx-auto max-w-5xl text-sm text-red-600">{(error as Error).message}</p>;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Entity resolution queue</h1>
        <p className="text-xs text-slate-500">
          <kbd className="rounded bg-slate-100 px-1">m</kbd> merge · <kbd className="rounded bg-slate-100 px-1">n</kbd> not a
          match · <kbd className="rounded bg-slate-100 px-1">s</kbd> skip · <kbd className="rounded bg-slate-100 px-1">↑↓</kbd>{" "}
          navigate
        </p>
      </div>

      {items.length === 0 && <p className="text-sm text-slate-400">No pending candidates.</p>}

      <ul className="space-y-3">
        {items.map((item, i) => (
          <li
            key={item.id}
            data-testid={`resolution-item-${item.id}`}
            onClick={() => setFocusedIndex(i)}
            className={`cursor-pointer rounded border p-3 ${i === focusedIndex ? "border-slate-900 bg-white" : "border-slate-200 bg-white/60"}`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">similarity {Math.round(item.similarity_score * 100)}%</span>
              <div className="flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    decide.mutate({ id: item.id, decision: "merged" });
                  }}
                  className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100"
                >
                  Merge
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    decide.mutate({ id: item.id, decision: "not_a_match" });
                  }}
                  className="rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                >
                  Not a match
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    decide.mutate({ id: item.id, decision: "skipped" });
                  }}
                  className="rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                >
                  Skip
                </button>
              </div>
            </div>
            <ComparisonCard item={item} />
            <div className="mt-2 grid grid-cols-2 gap-4">
              <NeighborhoodList label="existing entity's connections" neighbors={item.neighborsA} />
              <NeighborhoodList label="new entity's connections" neighbors={item.neighborsB} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
