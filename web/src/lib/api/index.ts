import { useMemo } from "react";
import { useAuth } from "../AuthContext";
import { ApiError, type WithToken } from "./client";
import { createObjectsApi } from "./objects";
import { createCasesApi } from "./cases";
import { createGraphApi } from "./graph";
import { createIngestionApi } from "./ingestion";
import { createResolutionQueueApi } from "./resolutionQueue";
import { createAdminApi } from "./admin";
import { createAuditApi } from "./audit";

export { ApiError };
export * from "./types";

// Per-domain modules (objects.ts, cases.ts, graph.ts, ...) each build their methods on the same
// WithToken closure and get merged into one flat object here — the hook's public shape (every
// call site does api.listCases(...), api.getObject(...), etc.) is unchanged from before this
// file was split; only where each method's implementation lives changed. Splitting this into
// namespaces instead (api.cases.list()) would be a real call-site-breaking change across every
// screen, which is exactly why ARCHITECTURE_AUDIT.md flagged this file as a split candidate but
// didn't do it as a "pure" refactor — this keeps it pure.
export function useApiClient() {
  const { getValidAccessToken } = useAuth();

  return useMemo(() => {
    const withToken: WithToken = async (fn) => {
      const token = await getValidAccessToken();
      if (!token) throw new ApiError(401, "not authenticated");
      return fn(token);
    };

    return {
      ...createObjectsApi(withToken),
      ...createCasesApi(withToken),
      ...createGraphApi(withToken),
      ...createIngestionApi(withToken),
      ...createResolutionQueueApi(withToken),
      ...createAdminApi(withToken),
      ...createAuditApi(withToken),
    };
  }, [getValidAccessToken]);
}
