import { request, type WithToken } from "./client";
import type { AppUser, RetentionRun } from "./types";

export function createAdminApi(withToken: WithToken) {
  return {
    listAdminUsers: () => withToken((token) => request<{ users: AppUser[] }>("/admin/users", token)),

    updateAdminUser: (id: string, body: { role?: string; clearance?: string; isActive?: boolean; purpose?: string }) =>
      withToken((token) =>
        request<{ user: AppUser }>(`/admin/users/${id}`, token, { method: "PATCH", body: JSON.stringify(body) }),
      ),

    listRetentionRuns: () => withToken((token) => request<{ runs: RetentionRun[] }>("/admin/retention/runs", token)),

    runRetentionEnforcement: (purpose: string) =>
      withToken((token) =>
        request<{ runId: string; objectsAnonymized: number; edgesAnonymized: number }>("/admin/retention/run", token, {
          method: "POST",
          body: JSON.stringify({ purpose }),
        }),
      ),
  };
}
