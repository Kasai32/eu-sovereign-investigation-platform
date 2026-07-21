import { useEffect, useRef } from "react";
import cytoscape, { type Core } from "cytoscape";
import type { GraphEdge, GraphNode } from "../lib/api";

const CLASSIFICATION_COLORS: Record<string, string> = {
  PUBLIC: "#94a3b8",
  INTERNAL: "#3b82f6",
  SENSITIVE: "#d97706",
  RESTRICTED: "#dc2626",
};

function displayLabel(n: GraphNode): string {
  return (n.properties.name as string) ?? (n.properties.account_number as string) ?? n.object_type;
}

export type GraphCanvasProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  pathHighlightIds: Set<string>;
  hiddenIds: Set<string>;
  pinnedIds: Set<string>;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onBackgroundClick: () => void;
};

// A thin, imperative wrapper: Cytoscape owns the canvas and its own internal render state, so
// this component syncs props -> cy instance in effects rather than trying to make Cytoscape
// itself a React-controlled tree (fighting that is worse than a clean imperative boundary).
export function GraphCanvas(props: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: "node",
          style: {
            "background-color": (ele) => CLASSIFICATION_COLORS[ele.data("classification")] ?? "#64748b",
            label: "data(label)",
            "font-size": 10,
            color: "#1e293b",
            "text-valign": "bottom",
            "text-margin-y": 4,
            width: 28,
            height: 28,
            "border-width": 2,
            "border-color": "#fff",
          },
        },
        { selector: "node:selected", style: { "border-width": 4, "border-color": "#0f172a" } },
        { selector: "node.path-highlight", style: { "border-width": 4, "border-color": "#16a34a" } },
        { selector: "node.pinned", style: { "border-style": "double", "border-width": 5 } },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#cbd5e1",
            "target-arrow-color": "#cbd5e1",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#64748b",
          },
        },
        { selector: "edge:selected", style: { width: 3, "line-color": "#0f172a", "target-arrow-color": "#0f172a" } },
        { selector: "edge.path-highlight", style: { width: 3, "line-color": "#16a34a", "target-arrow-color": "#16a34a" } },
      ],
      layout: { name: "cose", animate: false },
    });

    cy.on("tap", "node", (evt) => propsRef.current.onSelectNode(evt.target.id()));
    cy.on("tap", "edge", (evt) => propsRef.current.onSelectEdge(evt.target.id()));
    cy.on("tap", (evt) => {
      if (evt.target === cy) propsRef.current.onBackgroundClick();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Sync graph data: add anything new, remove anything gone, re-run layout only when the node
  // set actually changed (not on every selection/pin toggle).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const currentIds = new Set(cy.nodes().map((n) => n.id()));
    const nextIds = new Set(props.nodes.map((n) => n.id));
    let changed = false;

    for (const n of props.nodes) {
      if (!currentIds.has(n.id)) {
        cy.add({ group: "nodes", data: { id: n.id, label: displayLabel(n), classification: n.classification } });
        changed = true;
      }
    }
    for (const e of props.edges) {
      if (cy.getElementById(e.id).empty()) {
        cy.add({
          group: "edges",
          data: {
            id: e.id,
            source: e.source_object_id,
            target: e.target_object_id,
            label: e.relationship,
            classification: e.classification,
          },
        });
        changed = true;
      }
    }
    cy.nodes().forEach((n) => {
      if (!nextIds.has(n.id())) {
        n.remove();
        changed = true;
      }
    });

    if (changed) {
      cy.layout({ name: "cose", animate: false }).run();
    }
  }, [props.nodes, props.edges]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().unselect();
    if (props.selectedNodeId) cy.getElementById(props.selectedNodeId).select();
    if (props.selectedEdgeId) cy.getElementById(props.selectedEdgeId).select();
  }, [props.selectedNodeId, props.selectedEdgeId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("path-highlight");
    props.pathHighlightIds.forEach((id) => cy.getElementById(id).addClass("path-highlight"));
  }, [props.pathHighlightIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().forEach((n) => {
      n.style("display", props.hiddenIds.has(n.id()) ? "none" : "element");
    });
  }, [props.hiddenIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().forEach((n) => {
      const shouldPin = props.pinnedIds.has(n.id());
      if (shouldPin) {
        n.lock();
        n.addClass("pinned");
      } else {
        n.unlock();
        n.removeClass("pinned");
      }
    });
  }, [props.pinnedIds]);

  return <div ref={containerRef} className="h-full w-full" data-testid="graph-canvas" />;
}
