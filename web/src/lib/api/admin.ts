import { request, type WithToken } from "./client";
import type { AppUser } from "./types";

export function createAdminApi(withToken: WithToken) {
  return {
    listAdminUsers: () => withToken((token) => request<{ users: AppUser[] }>("/admin/users", token)),

    updateAdminUser: (id: string, body: { role?: string; clearance?: string; isActive?: boolean; purpose?: string }) =>
      withToken((token) =>
        request<{ user: AppUser }>(`/admin/users/${id}`, token, { method: "PATCH", body: JSON.stringify(body) }),
      ),
  };
}
