import { Link, Outlet } from "@tanstack/react-router";
import { useAuth } from "./lib/AuthContext";

// Root layout: shows a sign-in screen when unauthenticated, nav + Outlet otherwise. The
// callback route is exempt (it must render while unauthenticated, mid-login).
export function RootLayout() {
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
      <nav className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 print:hidden">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-slate-900">Investigation Platform</span>
          <Link to="/search" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
            Search
          </Link>
          <Link to="/cases" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
            Cases
          </Link>
          <Link to="/intake" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
            Intake
          </Link>
          <Link
            to="/resolution-queue"
            className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900"
          >
            Resolution queue
          </Link>
          {auth.roles.some((r) => ["compliance", "admin"].includes(r)) && (
            <Link to="/audit" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
              Audit
            </Link>
          )}
          {auth.roles.includes("admin") && (
            <Link to="/admin/users" className="text-sm text-slate-600 hover:text-slate-900 [&.active]:font-semibold [&.active]:text-slate-900">
              Users
            </Link>
          )}
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
      <main className="p-6 print:p-0">
        <Outlet />
      </main>
    </div>
  );
}
