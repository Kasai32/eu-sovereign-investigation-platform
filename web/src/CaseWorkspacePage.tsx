import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useApiClient, type GraphEdge, type GraphNode } from "./lib/api";
import { ClassificationBadge } from "./components/ClassificationBadge";
import { GraphCanvas } from "./components/GraphCanvas";

// Server caps at 500 nodes (see api/src/routes/graph.ts); this is the UI-side warning
// threshold from the build prompt's rendering budget ("warn past ~2,000 visible elements").
// Kept as a real, if currently unreachable at this dataset's scale, guard rather than deleted.
const WARN_NODE_COUNT = 2000;

function displayLabel(props: Record<string, unknown>, fallback: string): string {
  return (props.name as string) ?? (props.account_number as string) ?? fallback;
}

// Thin route wrapper — kept separate from CaseWorkspace so tests can render the workspace
// directly with a fixed caseId, without needing a full router context.
export function CaseWorkspacePage() {
  const { id } = useParams({ from: "/cases/$id" });
  return <CaseWorkspace caseId={id} />;
}

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const api = useApiClient();
  const queryClient = useQueryClient();

  const [purpose, setPurpose] = useState("");
  const [submittedPurpose, setSubmittedPurpose] = useState("");

  const caseQuery = useQuery({
    queryKey: ["case", caseId, submittedPurpose],
    queryFn: () => api.getCase(caseId, submittedPurpose),
    enabled: submittedPurpose.length > 0,
  });

  const graphSeedQuery = useQuery({
    queryKey: ["case-graph", caseId, submittedPurpose],
    queryFn: () => api.getCaseGraph(caseId),
    enabled: submittedPurpose.length > 0,
  });

  const [nodes, setNodes] = useState<Map<string, GraphNode>>(new Map());
  const [edges, setEdges] = useState<Map<string, GraphEdge>>(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathHighlightIds, setPathHighlightIds] = useState<Set<string>>(new Set());
  const [noteBody, setNoteBody] = useState("");

  // Seed local graph state once from the case's pinned entities. Merges (not replaces) so an
  // in-progress expansion isn't wiped out if this query refetches.
  useEffect(() => {
    if (!graphSeedQuery.data) return;
    setNodes((prev) => {
      const next = new Map(prev);
      for (const n of graphSeedQuery.data.nodes) next.set(n.id, n);
      return next;
    });
    setEdges((prev) => {
      const next = new Map(prev);
      for (const e of graphSeedQuery.data.edges) next.set(e.id, e);
      return next;
    });
  }, [graphSeedQuery.data]);

  function mergeGraph(newNodes: GraphNode[], newEdges: GraphEdge[]) {
    setNodes((prev) => {
      const next = new Map(prev);
      for (const n of newNodes) next.set(n.id, n);
      return next;
    });
    setEdges((prev) => {
      const next = new Map(prev);
      for (const e of newEdges) next.set(e.id, e);
      return next;
    });
  }

  const expandMutation = useMutation({
    mutationFn: (nodeId: string) => api.expandGraph(nodeId, 1, "expanding neighbors during investigation"),
    onSuccess: (data) => mergeGraph(data.nodes, data.edges),
  });

  const pathMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => api.findPath(from, to, "path-finding during investigation"),
    onSuccess: (data) => {
      if (data.found) {
        mergeGraph(data.nodes, data.edges);
        setPathHighlightIds(new Set(data.path));
      } else {
        setPathHighlightIds(new Set());
      }
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: () => api.addNote(caseId, noteBody, "investigation note added"),
    onSuccess: () => {
      setNoteBody("");
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
  });

  const pinEntityMutation = useMutation({
    mutationFn: (objectId: string) => api.pinEntity(caseId, objectId, "entity added to case from graph inspector"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["case", caseId] }),
  });

  const unpinEntityMutation = useMutation({
    mutationFn: (objectId: string) => api.unpinEntity(caseId, objectId, "entity removed from case from graph inspector"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["case", caseId] }),
  });

  function handleSelectNode(id: string) {
    if (pathFrom && pathFrom !== id) {
      pathMutation.mutate({ from: pathFrom, to: id });
      setPathFrom(null);
    }
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }

  function handleSelectEdge(id: string) {
    setSelectedEdgeId(id);
    setSelectedNodeId(null);
  }

  if (!submittedPurpose) {
    return (
      <div className="mx-auto max-w-md">
        <h1 className="mb-2 text-xl font-semibold text-slate-900">Reason for opening this case</h1>
        <p className="mb-4 text-sm text-slate-500">
          Required before opening the case workspace — recorded in the audit log against your account.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (purpose.trim()) setSubmittedPurpose(purpose.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. reviewing assigned structuring alert"
            className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
            autoFocus
          />
          <button type="submit" className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700">
            Continue
          </button>
        </form>
      </div>
    );
  }

  if (caseQuery.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (caseQuery.error) {
    const msg = caseQuery.error instanceof Error ? caseQuery.error.message : String(caseQuery.error);
    return <p className="text-sm text-red-600">{msg === "not found" ? "Not found or not visible to you." : msg}</p>;
  }
  if (!caseQuery.data) return null;

  const { case: theCase, entities, notes, activity } = caseQuery.data;
  const pinnedObjectIds = new Set(entities.map((e) => e.object_id));
  const selectedNode = selectedNodeId ? nodes.get(selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? edges.get(selectedEdgeId) : null;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">{theCase.title}</h1>
        <ClassificationBadge classification={theCase.classification} />
        <span className="text-sm text-slate-500">{theCase.status}</span>
        {/* Plain anchor, not TanStack Router's <Link>: keeps CaseWorkspace renderable in
            isolation (no router context) for CaseWorkspacePage.test.tsx, at the cost of a full
            page navigation for this one export link — an acceptable tradeoff for a non-hot-path
            action. */}
        <a href={`/cases/${caseId}/report`} className="ml-auto text-sm text-slate-600 underline hover:text-slate-900">
          Export report
        </a>
      </div>

      {nodes.size > WARN_NODE_COUNT && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {nodes.size} nodes visible — consider narrowing the graph, rendering may degrade past this size.
        </div>
      )}

      <div className="flex gap-4" style={{ height: "70vh" }}>
        {/* Left: case file */}
        <div className="w-72 shrink-0 overflow-y-auto rounded border border-slate-200 bg-white p-3" data-testid="case-file-pane">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Entities ({entities.length})</h2>
          <ul className="mb-4 space-y-1">
            {entities.map((e) => (
              <li key={e.object_id}>
                <button
                  onClick={() => handleSelectNode(e.object_id)}
                  data-testid={`case-entity-${e.object_id}`}
                  className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50 ${
                    selectedNodeId === e.object_id ? "bg-slate-100 font-medium" : ""
                  }`}
                >
                  {displayLabel(e.properties, e.object_type)}
                  <span className="ml-1 text-xs text-slate-400">{e.object_type}</span>
                </button>
              </li>
            ))}
          </ul>

          <h2 className="mb-2 text-sm font-semibold text-slate-700">Notes ({notes.length})</h2>
          <ul className="mb-2 space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded bg-slate-50 p-2 text-xs">
                <div className="mb-0.5 font-medium text-slate-700">{n.author_name}</div>
                <div className="text-slate-600">{n.body}</div>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (noteBody.trim()) addNoteMutation.mutate();
            }}
            className="mb-4 flex gap-1"
          >
            <input
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Add note…"
              className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
            />
            <button type="submit" className="rounded bg-slate-900 px-2 py-1 text-xs text-white">
              Add
            </button>
          </form>

          <h2 className="mb-2 text-sm font-semibold text-slate-700">Activity</h2>
          <ul className="space-y-1 text-xs text-slate-500">
            {activity.map((a) => (
              <li key={a.id}>
                {a.actor_name}: {a.action.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </div>

        {/* Center: graph canvas */}
        <div className="relative min-w-0 flex-1 rounded border border-slate-200 bg-white">
          {pathFrom && (
            <div className="absolute left-2 top-2 z-10 rounded bg-slate-900 px-2 py-1 text-xs text-white">
              Select a second node to find the shortest path…{" "}
              <button onClick={() => setPathFrom(null)} className="underline">
                cancel
              </button>
            </div>
          )}
          <GraphCanvas
            nodes={[...nodes.values()]}
            edges={[...edges.values()]}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            pathHighlightIds={pathHighlightIds}
            hiddenIds={hiddenIds}
            pinnedIds={pinnedIds}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            onBackgroundClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
          />
        </div>

        {/* Right: inspector */}
        <div className="w-72 shrink-0 overflow-y-auto rounded border border-slate-200 bg-white p-3" data-testid="inspector-pane">
          {!selectedNode && !selectedEdge && <p className="text-sm text-slate-400">Select a node or edge.</p>}

          {selectedNode && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">{displayLabel(selectedNode.properties, selectedNode.object_type)}</h2>
                <ClassificationBadge classification={selectedNode.classification} />
              </div>
              <table className="mb-3 w-full text-xs">
                <tbody>
                  {Object.entries(selectedNode.properties).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-100">
                      <td className="py-1 pr-2 font-medium text-slate-500">{k}</td>
                      <td className="py-1 text-slate-800">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => expandMutation.mutate(selectedNode.id)}
                  className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
                >
                  Expand
                </button>
                <button
                  onClick={() =>
                    setHiddenIds((prev) => {
                      const next = new Set(prev);
                      next.has(selectedNode.id) ? next.delete(selectedNode.id) : next.add(selectedNode.id);
                      return next;
                    })
                  }
                  className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
                >
                  {hiddenIds.has(selectedNode.id) ? "Unhide" : "Hide"}
                </button>
                <button
                  onClick={() =>
                    setPinnedIds((prev) => {
                      const next = new Set(prev);
                      next.has(selectedNode.id) ? next.delete(selectedNode.id) : next.add(selectedNode.id);
                      return next;
                    })
                  }
                  className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
                >
                  {pinnedIds.has(selectedNode.id) ? "Unpin position" : "Pin position"}
                </button>
                <button onClick={() => setPathFrom(selectedNode.id)} className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200">
                  Find path from here
                </button>
                {pinnedObjectIds.has(selectedNode.id) ? (
                  <button
                    onClick={() => unpinEntityMutation.mutate(selectedNode.id)}
                    className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100"
                  >
                    Remove from case
                  </button>
                ) : (
                  <button
                    onClick={() => pinEntityMutation.mutate(selectedNode.id)}
                    className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100"
                  >
                    Add to case
                  </button>
                )}
              </div>
            </div>
          )}

          {selectedEdge && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">{selectedEdge.relationship}</h2>
                <ClassificationBadge classification={selectedEdge.classification} />
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(selectedEdge.properties).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-100">
                      <td className="py-1 pr-2 font-medium text-slate-500">{k}</td>
                      <td className="py-1 text-slate-800">{String(v)}</td>
                    </tr>
                  ))}
                  {Object.keys(selectedEdge.properties).length === 0 && (
                    <tr>
                      <td className="py-1 text-slate-400">No properties recorded.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
