import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "./lib/api";
import { useAuth } from "./lib/AuthContext";

// S7: audit log viewer. Compliance/admin only in the UI, enforced independently by the API
// (both the route check and the audit_log RLS policy) — this page hiding itself is a courtesy.
export function AuditLogPage() {
  const api = useApiClient();
  const auth = useAuth();
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const canView = auth.roles.some((r) => ["compliance", "admin"].includes(r));

  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", action, resourceType, from, to],
    queryFn: () =>
      api.getAudit({
        action: action || undefined,
        resourceType: resourceType || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
        purpose: "compliance audit log review",
      }),
    enabled: canView,
  });

  if (!canView) return <p className="mx-auto max-w-5xl text-sm text-red-600">Compliance/admin only.</p>;

  // Deliberately NOT an early return on isLoading/error here: every filter keystroke changes
  // the query key, and an early return would unmount the filter inputs themselves on every
  // fetch — which briefly happens on every character typed — dropping focus and eating the
  // rest of whatever the user was typing. Found by actually typing into the field, not by
  // reading the code. Loading/error state is confined to the results table below instead.
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Audit log</h1>
        {data && (
          <span
            className={`rounded px-2 py-1 text-xs font-medium ${
              data.chain.is_valid ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
            }`}
          >
            {data.chain.is_valid ? "Chain verified" : `Chain broken at seq ${data.chain.first_broken_seq}`}
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="action (e.g. case.read)"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
          placeholder="resource type (e.g. case)"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm" />
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm" />
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{(error as Error).message}</p>}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-1.5 pr-4 font-medium">Seq</th>
            <th className="py-1.5 pr-4 font-medium">When</th>
            <th className="py-1.5 pr-4 font-medium">User</th>
            <th className="py-1.5 pr-4 font-medium">Action</th>
            <th className="py-1.5 pr-4 font-medium">Resource</th>
            <th className="py-1.5 font-medium">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {data?.entries.map((e) => (
            <tr key={e.seq} className="border-b border-slate-100">
              <td className="py-1.5 pr-4 text-slate-400">{e.seq}</td>
              <td className="py-1.5 pr-4 text-slate-500">{new Date(e.occurred_at).toLocaleString()}</td>
              <td className="py-1.5 pr-4">{e.user_name ?? e.user_id.slice(0, 8)}</td>
              <td className="py-1.5 pr-4">{e.action}</td>
              <td className="py-1.5 pr-4 text-slate-500">
                {e.resource_type ? `${e.resource_type} ${e.resource_id?.slice(0, 8)}…` : "—"}
              </td>
              <td className="py-1.5 text-slate-600">{e.purpose}</td>
            </tr>
          ))}
          {isLoading && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-slate-400">
                Loading…
              </td>
            </tr>
          )}
          {!isLoading && (data?.entries.length ?? 0) === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-slate-400">
                No entries match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
