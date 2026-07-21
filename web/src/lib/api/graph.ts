import { request, type WithToken } from "./client";
import type { ExpandResult, PathResult } from "./types";

export function createGraphApi(withToken: WithToken) {
  return {
    expandGraph: (nodeId: string, hops: number, purpose?: string) =>
      withToken((token) => {
        const search = new URLSearchParams({ nodeId, hops: String(hops) });
        if (purpose) search.set("purpose", purpose);
        return request<ExpandResult>(`/graph/expand?${search.toString()}`, token);
      }),

    findPath: (from: string, to: string, purpose?: string) =>
      withToken((token) => {
        const search = new URLSearchParams({ from, to });
        if (purpose) search.set("purpose", purpose);
        return request<PathResult>(`/graph/path?${search.toString()}`, token);
      }),
  };
}
