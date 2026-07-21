import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useApiClient, type CaseReport } from "./lib/api";
import { usePurposeGate } from "./lib/usePurposeGate";
import { ClassificationBadge } from "./components/ClassificationBadge";

function displayLabel(props: Record<string, unknown>, fallback: string): string {
  return (props.name as string) ?? (props.account_number as string) ?? fallback;
}

function toMarkdown(report: CaseReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.case.title}`);
  lines.push("");
  lines.push(`- Status: ${report.case.status}`);
  lines.push(`- Classification: ${report.case.classification}`);
  lines.push(`- Generated: ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(
    `- Basis: ${report.isFrozen ? `frozen evidence snapshot at case close (${new Date(report.frozenAt!).toLocaleString()})` : "live case data (case is not closed)"}`,
  );
  lines.push(`- Redacted to viewer clearance: ${report.viewerClearance}`);
  lines.push("");
  lines.push("## Entities");
  for (const e of report.entities) {
    lines.push(`### ${displayLabel(e.properties, e.object_type)} (${e.object_type}, ${e.classification})`);
    for (const [k, v] of Object.entries(e.properties)) {
      const meta = e.propertyMeta.find((m) => m.property_key === k);
      lines.push(`- **${k}**: ${v}${meta ? ` _(source: ${meta.source}, confidence ${meta.confidence ?? "n/a"})_` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Notes");
  for (const n of report.notes) {
    lines.push(`- **${n.author_name}** (${new Date(n.created_at).toLocaleString()}): ${n.body}`);
  }
  lines.push("");
  lines.push("## Activity");
  for (const a of report.activity) {
    lines.push(`- ${new Date(a.occurred_at).toLocaleString()} — ${a.actor_name}: ${a.action.replace(/_/g, " ")}`);
  }
  return lines.join("\n");
}

function downloadMarkdown(report: CaseReport) {
  const blob = new Blob([toMarkdown(report)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `case-report-${report.case.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// S7's headline export. Print-to-PDF uses the browser's native print dialog against this same
// HTML — deliberately not a server-side Playwright pipeline for this pass (see PHASE5_REVIEW.md)
// — plus a Markdown download built from the identical fetched data, so both formats always
// agree with each other and with what's on screen.
export function CaseReportPage() {
  const { id: caseId } = useParams({ from: "/cases/$id/report" });
  const api = useApiClient();
  const { submittedPurpose, gate } = usePurposeGate({
    title: "Reason for exporting this report",
    placeholder: "e.g. preparing SAR filing package",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["case-report", caseId, submittedPurpose],
    queryFn: () => api.getCaseReport(caseId, submittedPurpose),
    enabled: submittedPurpose.length > 0,
  });

  if (gate) return gate;

  if (isLoading) return <p className="mx-auto max-w-3xl text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="mx-auto max-w-3xl text-sm text-red-600">{(error as Error).message}</p>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700">
            Print / Save as PDF
          </button>
          <button onClick={() => downloadMarkdown(data)} className="rounded bg-slate-100 px-4 py-1.5 text-sm hover:bg-slate-200">
            Download Markdown
          </button>
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-white p-8 print:border-none print:p-0">
        <h1 className="mb-1 text-2xl font-semibold text-slate-900">{data.case.title}</h1>
        <div className="mb-4 flex items-center gap-2 text-sm text-slate-500">
          <ClassificationBadge classification={data.case.classification} />
          <span>{data.case.status}</span>
          <span>· generated {new Date(data.generatedAt).toLocaleString()}</span>
        </div>

        <div className="mb-6 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          {data.isFrozen ? (
            <>Basis: frozen evidence snapshot captured when this case closed on {new Date(data.frozenAt!).toLocaleString()}. Later changes to these entities are not reflected.</>
          ) : (
            <>Basis: live case data (this case is not closed; a report generated later may differ).</>
          )}
          <br />
          Redacted to your clearance ({data.viewerClearance}) — entities above this level, if any, are omitted automatically.
        </div>

        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Entities</h2>
        <div className="mb-6 space-y-4">
          {data.entities.map((e) => (
            <div key={e.object_id} className="border-b border-slate-100 pb-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium text-slate-900">{displayLabel(e.properties, e.object_type)}</span>
                <span className="text-xs text-slate-400">{e.object_type}</span>
                <ClassificationBadge classification={e.classification} />
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(e.properties).map(([k, v]) => {
                    const meta = e.propertyMeta.find((m) => m.property_key === k);
                    return (
                      <tr key={k}>
                        <td className="py-0.5 pr-3 font-medium text-slate-500">{k}</td>
                        <td className="py-0.5 pr-3 text-slate-800">{String(v)}</td>
                        <td className="py-0.5 text-slate-400">{meta ? `source: ${meta.source}` : "no provenance recorded"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {data.entities.length === 0 && <p className="text-sm text-slate-400">No entities visible at your clearance.</p>}
        </div>

        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Notes</h2>
        <ul className="mb-6 space-y-1 text-sm">
          {data.notes.map((n, i) => (
            <li key={i}>
              <span className="font-medium text-slate-700">{n.author_name}</span>{" "}
              <span className="text-xs text-slate-400">{new Date(n.created_at).toLocaleString()}</span>
              <div className="text-slate-600">{n.body}</div>
            </li>
          ))}
        </ul>

        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Activity</h2>
        <ul className="space-y-0.5 text-xs text-slate-500">
          {data.activity.map((a, i) => (
            <li key={i}>
              {new Date(a.occurred_at).toLocaleString()} — {a.actor_name}: {a.action.replace(/_/g, " ")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
