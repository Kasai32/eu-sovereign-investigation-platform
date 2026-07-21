import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { useAuth } from "./lib/AuthContext";
import { handleCallback } from "./lib/auth";
import { useApiClient, ApiError, type CaseSummary } from "./lib/api";
import { ClassificationBadge } from "./components/ClassificationBadge";
import { CaseWorkspacePage } from "./CaseWorkspacePage";

// ---------------------------------------------------------------------------
// Root layout: shows a sign-in screen when unauthenticated, nav + Outlet otherwise. The
// callback route is exempt (it must render while unauthenticated, mid-login).
// ---------------------------------------------------------------------------
function RootLayout() {
  const auth = useAuth();
  const isCallback = window.location.pathname === "/auth/callback";

  if (isCallback) return <Outlet />;

  if (!auth.tokens) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-slate-900">Investigation Platform</h1>
          <p className="mb-4 text-sm text-slate-500">Sign in with your organization account.</p>
          <button
            onClick={auth.login}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-slate-900">Investigation Platform</span>
          <Link to="/search" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
            Search
          </Link>
          <Link to="/cases" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
            Cases
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span>
            {auth.displayName} · {auth.roles.join(", ")}
          </span>
          <button onClick={auth.logout} className="text-slate-500 hover:text-slate-900">
            Sign out
          </button>
        </div>
      </nav>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

// ---------------------------------------------------------------------------
// /auth/callback — completes the PKCE exchange, then a hard reload so AuthProvider
// re-reads tokens from sessionStorage on mount rather than needing a state bridge.
// ---------------------------------------------------------------------------
function AuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    handleCallback(new URLSearchParams(window.location.search))
      .then(() => window.location.assign("/"))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  return (
    <div className="flex h-screen items-center justify-center text-sm text-slate-500">
      {error ? `Sign-in failed: ${error}` : "Signing in…"}
    </div>
  );
}

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: AuthCallbackPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/search" });
  },
});

// ---------------------------------------------------------------------------
// S3: object search / explorer
// ---------------------------------------------------------------------------
const OBJECT_TYPES = ["Person", "Organization", "Account", "Location", "Device", "Alert", "Document"];

function SearchPage() {
  const api = useApiClient();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["objects", submittedQ, type],
    queryFn: () => api.listObjects({ q: submittedQ || undefined, type: type || undefined }),
  });

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
          {OBJECT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
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

const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchPage });

// ---------------------------------------------------------------------------
// S4: entity detail — requires an explicit purpose-of-use before loading, mirroring the API's
// own requirement (this isn't just UI decoration; /objects/:id 400s without it).
// ---------------------------------------------------------------------------
function ObjectDetailPage() {
  const { id } = objectDetailRoute.useParams();
  const api = useApiClient();
  const [purpose, setPurpose] = useState("");
  const [submittedPurpose, setSubmittedPurpose] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["object", id, submittedPurpose],
    queryFn: () => api.getObject(id, submittedPurpose),
    enabled: submittedPurpose.length > 0,
  });

  if (!submittedPurpose) {
    return (
      <div className="max-w-md">
        <h1 className="mb-2 text-xl font-semibold text-slate-900">Reason for viewing</h1>
        <p className="mb-4 text-sm text-slate-500">
          Required before opening entity details — recorded in the audit log against your account.
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
            placeholder="e.g. investigating structuring alert on account ...4821"
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

const objectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/objects/$id",
  component: ObjectDetailPage,
});

// ---------------------------------------------------------------------------
// S1: case queue
// ---------------------------------------------------------------------------
function CasesPage() {
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

const casesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cases", component: CasesPage });

// S2: case workspace. Defined in a separate file (CaseWorkspacePage.tsx) since it's
// substantially larger than the other screens; it reads its :id param via useParams({ from:
// "/cases/$id" }) rather than importing this route object, avoiding a circular import.
const caseWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cases/$id",
  component: CaseWorkspacePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  callbackRoute,
  searchRoute,
  objectDetailRoute,
  casesRoute,
  caseWorkspaceRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
