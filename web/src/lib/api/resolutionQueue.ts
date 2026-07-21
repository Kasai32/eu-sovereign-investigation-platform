import { request, type WithToken } from "./client";
import type { ResolutionQueueItem } from "./types";

export function createResolutionQueueApi(withToken: WithToken) {
  return {
    listResolutionQueue: (status: string = "pending") =>
      withToken((token) => request<{ items: ResolutionQueueItem[] }>(`/resolution-queue?status=${status}`, token)),

    decideResolution: (id: string, decision: "merged" | "not_a_match" | "skipped", purpose?: string) =>
      withToken((token) =>
        request<{ ok: true }>(`/resolution-queue/${id}/decide`, token, {
          method: "POST",
          body: JSON.stringify({ decision, purpose }),
        }),
      ),

    undoResolution: (id: string, purpose?: string) =>
      withToken((token) =>
        request<{ ok: true }>(`/resolution-queue/${id}/undo`, token, { method: "POST", body: JSON.stringify({ purpose }) }),
      ),
  };
}
