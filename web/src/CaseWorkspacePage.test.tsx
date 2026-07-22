import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaseWorkspace } from "./CaseWorkspacePage";
import type { CaseStatus } from "../../shared/schemas/common";

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
    // Widened to the shared schema's union (not `as const`) so a test can override it to a
    // locked status without the fixture's inferred literal type rejecting it.
    status: "open" as CaseStatus,
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
  getCase: vi.fn(async () => fixtureCase as typeof fixtureCase),
  getCaseGraph: vi.fn(async () => fixtureGraph),
  addNote: vi.fn(async () => ({})),
  pinEntity: vi.fn(async () => ({ ok: true as const })),
  unpinEntity: vi.fn(async () => ({ ok: true as const })),
  setCaseStatus: vi.fn(async () => ({
    id: "case-1",
    status: "closed" as const,
    evidence_snapshot: {},
    closed_at: "2026-01-02T00:00:00Z",
  })),
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

async function passPurposeGate(user: ReturnType<typeof userEvent.setup>, purpose: string) {
  const purposeInput = await screen.findByPlaceholderText(/reviewing assigned structuring alert/i);
  await user.type(purposeInput, purpose);
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

describe("case workspace cross-pane linked selection", () => {
  beforeEach(() => {
    selectSpy.mockClear();
    getElementByIdMock.mockClear();
    mockApi.getCase.mockResolvedValue(fixtureCase);
    mockApi.setCaseStatus.mockClear();
  });

  it("selecting an entity in the case file pane highlights it in the graph and populates the inspector", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await passPurposeGate(user, "testing linked selection");

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

// The close-case control is what completes the alert→case→document→close cycle inside the
// product: PATCH /cases/:id/status has existed since Phase 1 but had no caller in the web app,
// so #50's deployment verification had to close its case with curl.
describe("case status control", () => {
  beforeEach(() => {
    mockApi.getCase.mockResolvedValue(fixtureCase);
    mockApi.setCaseStatus.mockClear();
  });

  it("closes a case with an explicit purpose-of-use, separate from the workspace's opening purpose", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await passPurposeGate(user, "reviewing assigned structuring alert");

    await user.click(await screen.findByTestId("change-status-button"));
    await user.selectOptions(screen.getByLabelText(/new status/i), "closed");

    const confirm = screen.getByRole("button", { name: /confirm/i });
    // The API 400s without a purpose; the control shouldn't let the request be made at all.
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/reason for this status change/i), "SAR filed, investigation concluded");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    // The purpose sent is the one typed here, NOT the workspace's "reviewing assigned
    // structuring alert" — the audit entry for closing has to say why it was closed.
    expect(mockApi.setCaseStatus).toHaveBeenCalledWith("case-1", "closed", "SAR filed, investigation concluded");
  });

  it("freezes note and entity controls on a closed case, matching the API's 409", async () => {
    mockApi.getCase.mockResolvedValue({ ...fixtureCase, case: { ...fixtureCase.case, status: "closed" as const } });
    const user = userEvent.setup();
    renderWorkspace();
    await passPurposeGate(user, "auditing a concluded case");

    expect(await screen.findByTestId("case-locked-notice")).toHaveTextContent(/closed/i);
    expect(screen.queryByPlaceholderText(/add note/i)).not.toBeInTheDocument();

    // Read-only graph exploration stays available; only the writes the API rejects are gone.
    await user.click(await screen.findByTestId("case-entity-obj-1"));
    const inspector = screen.getByTestId("inspector-pane");
    expect(within(inspector).getByRole("button", { name: /expand/i })).toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: /remove from case/i })).not.toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: /add to case/i })).not.toBeInTheDocument();
  });
});
