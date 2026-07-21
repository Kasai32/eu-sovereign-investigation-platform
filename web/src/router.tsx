import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { RootLayout } from "./Layout";
import { AuthCallbackPage } from "./AuthCallbackPage";
import { SearchPage } from "./SearchPage";
import { ObjectDetailPage } from "./ObjectDetailPage";
import { CasesPage } from "./CasesPage";
import { CaseWorkspacePage } from "./CaseWorkspacePage";
import { CaseReportPage } from "./CaseReportPage";
import { IntakePage } from "./IntakePage";
import { ResolutionQueuePage } from "./ResolutionQueuePage";
import { AdminUsersPage } from "./AdminUsersPage";
import { AuditLogPage } from "./AuditLogPage";

// Pure route-tree wiring. Every screen lives in its own file (see each import above) and is
// wired here as `path -> component` — this file used to also contain five of the page
// components inline (~500 lines), the one screen-file convention wasn't actually followed
// everywhere. Kept as flat files in src/, matching how CaseWorkspacePage/IntakePage/etc. were
// already organized, rather than introducing a new routes/ subdirectory convention alongside it.
const rootRoute = createRootRoute({ component: RootLayout });

const callbackRoute = createRoute({ getParentRoute: () => rootRoute, path: "/auth/callback", component: AuthCallbackPage });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/search" });
  },
});

const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchPage });
const objectDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/objects/$id", component: ObjectDetailPage });
const casesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cases", component: CasesPage });

// S2: case workspace. Reads its :id param via useParams({ from: "/cases/$id" }) rather than
// importing this route object, avoiding a circular import back into this file.
const caseWorkspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cases/$id", component: CaseWorkspacePage });
const caseReportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cases/$id/report", component: CaseReportPage });

const intakeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/intake", component: IntakePage });
const resolutionQueueRoute = createRoute({ getParentRoute: () => rootRoute, path: "/resolution-queue", component: ResolutionQueuePage });
const adminUsersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin/users", component: AdminUsersPage });
const auditLogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditLogPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  callbackRoute,
  searchRoute,
  objectDetailRoute,
  casesRoute,
  caseWorkspaceRoute,
  caseReportRoute,
  intakeRoute,
  resolutionQueueRoute,
  adminUsersRoute,
  auditLogRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
