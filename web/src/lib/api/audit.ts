import { request, type WithToken } from "./client";
import type { AuditChain, AuditEntry } from "./types";

export function createAuditApi(withToken: WithToken) {
  return {
    getAudit: (params: { userId?: string; action?: string; resourceType?: string; from?: string; to?: string; purpose: string }) =>
      withToken((token) => {
        const search = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
        return request<{ entries: AuditEntry[]; chain: AuditChain }>(`/audit?${search.toString()}`, token);
      }),
  };
}
