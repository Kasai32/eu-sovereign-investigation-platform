import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient, type AppUser } from "./lib/api";
import { useAuth } from "./lib/AuthContext";

const ROLES = ["analyst", "supervisor", "compliance", "admin"];
const CLEARANCES = ["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"];

// S7: user administration. Admin-only in the UI; the API enforces the same restriction
// independently, so this page hiding itself is a courtesy, not the actual security boundary.
export function AdminUsersPage() {
  const api = useApiClient();
  const auth = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.listAdminUsers() });

  const update = useMutation({
    mutationFn: (vars: { id: string; body: { role?: string; clearance?: string; isActive?: boolean } }) =>
      api.updateAdminUser(vars.id, { ...vars.body, purpose: "user administration" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  if (!auth.roles.includes("admin")) {
    return <p className="mx-auto max-w-5xl text-sm text-red-600">Admin only.</p>;
  }
  if (isLoading) return <p className="mx-auto max-w-5xl text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="mx-auto max-w-5xl text-sm text-red-600">{(error as Error).message}</p>;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Users</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Email</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Clearance</th>
            <th className="py-2 pr-4 font-medium">Active</th>
          </tr>
        </thead>
        <tbody>
          {data?.users.map((u: AppUser) => (
            <tr key={u.id} className="border-b border-slate-100">
              <td className="py-2 pr-4 text-slate-900">{u.display_name}</td>
              <td className="py-2 pr-4 text-slate-500">{u.email}</td>
              <td className="py-2 pr-4">
                <select
                  value={u.role}
                  onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-4">
                <select
                  value={u.clearance}
                  onChange={(e) => update.mutate({ id: u.id, body: { clearance: e.target.value } })}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  {CLEARANCES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-4">
                <input
                  type="checkbox"
                  checked={u.is_active}
                  onChange={(e) => update.mutate({ id: u.id, body: { isActive: e.target.checked } })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
