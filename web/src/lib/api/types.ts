export type ObjectSummary = {
  id: string;
  object_type: string;
  properties: Record<string, unknown>;
  classification: "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED";
  created_at: string;
};

export type PropertyMeta = {
  property_key: string;
  source: string;
  confidence: number | null;
  classification: string;
  ingested_at: string;
  raw_source_ref: string | null;
};

export type Neighbor = {
  edge_id: string;
  relationship: string;
  edge_properties: Record<string, unknown>;
  edge_classification: string;
  neighbor_id: string;
  direction: "incoming" | "outgoing";
};

export type ObjectDetail = {
  object: ObjectSummary & { canonical_of: string | null };
  propertyMeta: PropertyMeta[];
  neighbors: Neighbor[];
};

export type CaseSummary = {
  id: string;
  title: string;
  status: "open" | "under_review" | "closed" | "archived";
  priority: string;
  classification: string;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  entity_count: number;
};

export type CaseEntity = {
  object_id: string;
  object_type: string;
  properties: Record<string, unknown>;
  classification: string;
  pinned_by: string;
  pinned_at: string;
};

export type CaseNote = { id: string; body: string; author_id: string; author_name: string; created_at: string };
export type CaseActivity = {
  id: string;
  action: string;
  details: Record<string, unknown>;
  actor_id: string;
  actor_name: string;
  occurred_at: string;
};
export type CaseMember = { user_id: string; display_name: string; role: string };

export type CaseDetail = {
  case: CaseSummary & { evidence_snapshot: unknown; closed_at: string | null };
  entities: CaseEntity[];
  notes: CaseNote[];
  activity: CaseActivity[];
  members: CaseMember[];
};

export type GraphNode = { id: string; object_type: string; properties: Record<string, unknown>; classification: string };
export type GraphEdge = {
  id: string;
  source_object_id: string;
  target_object_id: string;
  relationship: string;
  properties: Record<string, unknown>;
  classification: string;
};

export type ExpandResult = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; requestedHops: number };
export type PathResult =
  | { found: false; nodes: []; edges: []; budgetExceeded: boolean }
  | { found: true; path: string[]; hops: number; nodes: GraphNode[]; edges: GraphEdge[] };

export type ObjectType = {
  id: string;
  name: string;
  property_schema: { type?: string; required?: string[]; properties?: Record<string, { type?: string; format?: string }> };
  version: number;
};

export type RelationshipType = { id: string; name: string };

export type IngestionSource = {
  id: string;
  name: string;
  default_classification: string;
  retention_days: number | null;
  created_at: string;
};

export type MappingTemplate = {
  id: string;
  source_id: string;
  name: string;
  object_type_id: string;
  match_property: string;
  mapping: Record<string, string>;
  created_at: string;
};

export type EdgeMappingTemplate = {
  id: string;
  source_id: string;
  name: string;
  relationship_type_id: string;
  source_object_type_id: string;
  source_match_column: string;
  source_match_property: string;
  target_object_type_id: string;
  target_match_column: string;
  target_match_property: string;
  property_mapping: Record<string, string>;
  default_classification: string;
  created_at: string;
};

export type IngestionRun = {
  id: string;
  source_id: string;
  template_id: string | null;
  edge_template_id: string | null;
  source_name: string;
  template_name: string;
  filename: string;
  status: "pending" | "running" | "completed" | "completed_with_errors" | "failed";
  records_total: number;
  records_ingested: number;
  records_quarantined: number;
  records_auto_merged: number;
  records_queued_for_review: number;
  started_at: string;
  completed_at: string | null;
};

export type IngestionRunError = { row_number: number; raw_row: Record<string, string>; error_message: string; created_at: string };

export type ResolutionQueueItem = {
  id: string;
  similarity_score: number;
  decision: "pending" | "merged" | "not_a_match" | "skipped";
  objectA: ObjectSummary;
  objectB: ObjectSummary;
  neighborsA: { relationship: string; neighbor_id: string; neighbor_type: string }[];
  neighborsB: { relationship: string; neighbor_id: string; neighbor_type: string }[];
};

export type AppUser = {
  id: string;
  email: string;
  display_name: string;
  role: "analyst" | "supervisor" | "compliance" | "admin";
  clearance: "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED";
  is_active: boolean;
  created_at: string;
};

export type AuditEntry = {
  seq: string;
  user_id: string;
  user_name: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  purpose: string;
  details: Record<string, unknown>;
  occurred_at: string;
};

export type AuditChain = { is_valid: boolean; first_broken_seq: string | null };

export type CaseReport = {
  case: CaseSummary & { evidence_snapshot: unknown; closed_at: string | null };
  isFrozen: boolean;
  frozenAt: string | null;
  entities: { object_id: string; object_type: string; properties: Record<string, unknown>; classification: string; propertyMeta: PropertyMeta[] }[];
  notes: { body: string; author_name: string; created_at: string }[];
  activity: { action: string; details: Record<string, unknown>; actor_name: string; occurred_at: string }[];
  viewerClearance: string;
  generatedAt: string;
};
