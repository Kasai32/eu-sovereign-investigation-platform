import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useApiClient, ApiError } from "./lib/api";
import { usePurposeGate } from "./lib/usePurposeGate";
import { ClassificationBadge } from "./components/ClassificationBadge";

// S4: entity detail — requires an explicit purpose-of-use before loading, mirroring the API's
// own requirement (this isn't just UI decoration; /objects/:id 400s without it).
export function ObjectDetailPage() {
  const { id } = useParams({ from: "/objects/$id" });
  const api = useApiClient();
  const { submittedPurpose, gate } = usePurposeGate({
    title: "Reason for viewing",
    description: "Required before opening entity details — recorded in the audit log against your account.",
    placeholder: "e.g. investigating structuring alert on account ...4821",
    containerClassName: "max-w-md",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["object", id, submittedPurpose],
    queryFn: () => api.getObject(id, submittedPurpose),
    enabled: submittedPurpose.length > 0,
  });

  if (gate) return gate;

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) {
    const msg = error instanceof ApiError && error.status === 404 ? "Not found or not visible to you." : (error as Error).message;
    return <p className="text-sm text-red-600">{msg}</p>;
  }
  if (!data) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">
          {(data.object.properties.name as string) ?? data.object.id}
        </h1>
        <ClassificationBadge classification={data.object.classification} />
        <span className="text-sm text-slate-500">{data.object.object_type}</span>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Properties</h2>
        <table className="w-full max-w-2xl border-collapse text-sm">
          <tbody>
            {Object.entries(data.object.properties).map(([key, value]) => {
              const meta = data.propertyMeta.find((m) => m.property_key === key);
              return (
                <tr key={key} className="border-b border-slate-100">
                  <td className="py-1.5 pr-4 font-medium text-slate-600">{key}</td>
                  <td className="py-1.5 pr-4 text-slate-900">{String(value)}</td>
                  <td className="py-1.5 text-xs text-slate-400">
                    {meta ? `${meta.source} · confidence ${meta.confidence ?? "n/a"}` : "no provenance recorded"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Connections ({data.neighbors.length})</h2>
        <ul className="space-y-1 text-sm">
          {data.neighbors.map((n) => (
            <li key={n.edge_id} className="flex items-center gap-2">
              <span className="text-slate-500">{n.direction === "outgoing" ? "→" : "←"}</span>
              <span className="text-slate-600">{n.relationship}</span>
              <Link to="/objects/$id" params={{ id: n.neighbor_id }} className="text-slate-900 hover:underline">
                {n.neighbor_id}
              </Link>
              <ClassificationBadge classification={n.edge_classification} />
            </li>
          ))}
          {data.neighbors.length === 0 && <li className="text-slate-400">No connections visible.</li>}
        </ul>
      </section>
    </div>
  );
}
