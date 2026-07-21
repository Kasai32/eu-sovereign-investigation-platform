import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaseWorkspace } from "./CaseWorkspacePage";

// Cross-pane linked selection is the P0 requirement from the build prompt: "selecting an
// entity in any view highlights it everywhere else... write an integration test for it, don't
// just wire it up for a demo." This test exercises the real CaseWorkspace component tree (case
// file pane, GraphCanvas, inspector pane, and the shared selection state wiring them together)
// with mocks only at the two genuine boundaries: the network (useApiClient) and the third-party
// rendering library (cytoscape, which needs a real canvas jsdom doesn't provide).
const { selectSpy, getElementByIdMock } = vi.hoisted(() => ({
  selectSpy: vi.fn(),
  getElementByIdMock: vi.fn(),
}));

vi.mock("cytoscape", () => {
  const stubEl = {
    select: selectSpy,
    unselect: vi.fn(),
    addClass: vi.fn(),
    removeClass: vi.fn(),
    remove: vi.fn(),
    empty: () => true,
    lock: vi.fn(),
    unlock: vi.fn(),
    style: vi.fn(),
    id: () => "",
  };
  getElementByIdMock.mockReturnValue(stubEl);
  const collectionStub = { forEach: () => {}, map: () => [], unselect: vi.fn(), removeClass: vi.fn() };
  const cyInstance = {
    on: vi.fn(),
    add: vi.fn(),
    nodes: () => collectionStub,
    edges: () => collectionStub,
    elements: () => collectionStub,
    getElementById: getElementByIdMock,
    layout: () => ({ run: vi.fn() }),
    destroy: vi.fn(),
  };
  return { default: vi.fn(() => cyInstance) };
});

const fixtureCase = {
  case: {
    id: "case-1",
    title: "Test Case",
    status: "open" as const,
    priority: "normal",
    classification: "INTERNAL",
    assigned_to: null,
    created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    evidence_snapshot: null,
    closed_at: null,
  },
  entities: [
    {
      object_id: "obj-1",
      object_type: "Person",
      properties: { name: "Jordan Vance" },
      classification: "INTERNAL",
      pinned_by: "u1",
      pinned_at: "2026-01-01T00:00:00Z",
    },
    {
      object_id: "obj-2",
      object_type: "Account",
      properties: { account_number: "...4821" },
      classification: "SENSITIVE",
      pinned_by: "u1",
      pinned_at: "2026-01-01T00:00:00Z",
    },
  ],
  notes: [],
  activity: [],
  members: [],
};

const fixtureGraph = {
  nodes: [
    { id: "obj-1", object_type: "Person", properties: { name: "Jordan Vance" }, classification: "INTERNAL" },
    { id: "obj-2", object_type: "Account", properties: { account_number: "...4821" }, classification: "SENSITIVE" },
  ],
  edges: [],
};

const mockApi = {
  getCase: vi.fn(async () => fixtureCase),
  getCaseGraph: vi.fn(async () => fixtureGraph),
  addNote: vi.fn(async () => ({})),
  pinEntity: vi.fn(async () => ({ ok: true as const })),
  unpinEntity: vi.fn(async () => ({ ok: true as const })),
  setCaseStatus: vi.fn(async () => ({})),
  expandGraph: vi.fn(async () => ({ nodes: [], edges: [], truncated: false, requestedHops: 1 })),
  findPath: vi.fn(async () => ({ found: false as const, nodes: [] as const, edges: [] as const, budgetExceeded: false })),
};

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return { ...actual, useApiClient: () => mockApi };
});

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CaseWorkspace caseId="case-1" />
    </QueryClientProvider>,
  );
}

describe("case workspace cross-pane linked selection", () => {
  beforeEach(() => {
    selectSpy.mockClear();
    getElementByIdMock.mockClear();
  });

  it("selecting an entity in the case file pane highlights it in the graph and populates the inspector", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const purposeInput = await screen.findByPlaceholderText(/reviewing assigned structuring alert/i);
    await user.type(purposeInput, "testing linked selection");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    const entityButton = await screen.findByTestId("case-entity-obj-1");

    // Before any selection, the inspector shows its empty state.
    expect(screen.getByTestId("inspector-pane")).toHaveTextContent(/select a node or edge/i);

    await user.click(entityButton);

    // 1. Inspector pane reflects the selected entity's details (name appears both as the
    // heading and as a property row, so scope to the heading specifically).
    const inspector = screen.getByTestId("inspector-pane");
    expect(within(inspector).getByRole("heading", { name: "Jordan Vance" })).toBeInTheDocument();

    // 2. Case file pane visually marks the same entity as selected.
    expect(entityButton.className).toMatch(/bg-slate-100/);

    // 3. The graph canvas was told to select the same node id — proving the selection
    // genuinely reached the third pane via props/effects, not just local component state.
    expect(getElementByIdMock).toHaveBeenCalledWith("obj-1");
    expect(selectSpy).toHaveBeenCalled();
  });
});
