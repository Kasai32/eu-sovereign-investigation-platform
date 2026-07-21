import { request, type WithToken } from "./client";
import type { ObjectDetail, ObjectSummary, ObjectType, RelationshipType } from "./types";

export function createObjectsApi(withToken: WithToken) {
  return {
    listObjects: (params: { q?: string; type?: string } = {}) =>
      withToken((token) => {
        const search = new URLSearchParams();
        if (params.q) search.set("q", params.q);
        if (params.type) search.set("type", params.type);
        const qs = search.toString();
        return request<{ objects: ObjectSummary[] }>(`/objects${qs ? `?${qs}` : ""}`, token);
      }),

    getObject: (id: string, purpose: string) =>
      withToken((token) =>
        request<ObjectDetail>(`/objects/${id}?purpose=${encodeURIComponent(purpose)}`, token),
      ),

    listObjectTypes: () => withToken((token) => request<{ objectTypes: ObjectType[] }>("/object-types", token)),

    listRelationshipTypes: () =>
      withToken((token) => request<{ relationshipTypes: RelationshipType[] }>("/relationship-types", token)),
  };
}
