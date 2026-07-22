import { z } from "zod";
import { caseStatusSchema, classificationSchema, isoTimestampSchema, purposeSchema, uuidSchema } from "./common.js";

// Single source of truth for GET /cases/:id's request and response shapes, imported by both
// api/src/routes/cases/workspace.ts (validates what it actually sends) and
// web/src/lib/api/cases.ts (validates what it actually received) — see shared/README.md for
// why this exists and how to add the next route's schema here.

// Re-exported under the names they had while they lived in this file, so nothing that already
// imports them from here had to change when they moved to ./common.ts for a second route's use.
export { classificationSchema, caseStatusSchema };

export const caseDetailRequestSchema = z.object({
  id: uuidSchema,
  // Same fix as caseStatus.ts: an omitted `purpose` used to get Zod's generic invalid_type
  // message here, worse than the pre-schema route's own wording. See purposeSchema's comment.
  purpose: purposeSchema("purpose is required to open a case"),
});

// Matches `SELECT * FROM cases WHERE id = $1` exactly (db/migrations/003_cases.sql) — no
// `entity_count`, unlike the list endpoint's row shape. A prior hand-written version of this
// type claimed entity_count here too (copied from the list endpoint's CaseSummary type); it
// was never actually present in this response, and nothing happened to read it yet. That's
// the exact failure mode this schema closes off: the next thing to read it would have gotten
// `undefined` silently instead of a build failure.
export const caseDetailCaseSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  status: caseStatusSchema,
  priority: z.string(),
  classification: classificationSchema,
  created_by: uuidSchema,
  assigned_to: uuidSchema.nullable(),
  evidence_snapshot: z.unknown().nullable(),
  closed_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export const caseDetailEntitySchema = z.object({
  object_id: uuidSchema,
  object_type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  classification: classificationSchema,
  pinned_by: uuidSchema,
  pinned_at: isoTimestampSchema,
});

export const caseDetailNoteSchema = z.object({
  id: uuidSchema,
  body: z.string(),
  author_id: uuidSchema,
  author_name: z.string(),
  created_at: isoTimestampSchema,
});

export const caseDetailActivitySchema = z.object({
  id: uuidSchema,
  action: z.string(),
  details: z.record(z.string(), z.unknown()),
  actor_id: uuidSchema,
  actor_name: z.string(),
  occurred_at: isoTimestampSchema,
});

export const caseDetailMemberSchema = z.object({
  user_id: uuidSchema,
  display_name: z.string(),
  role: z.string(),
});

export const caseDetailResponseSchema = z.object({
  case: caseDetailCaseSchema,
  entities: z.array(caseDetailEntitySchema),
  notes: z.array(caseDetailNoteSchema),
  activity: z.array(caseDetailActivitySchema),
  members: z.array(caseDetailMemberSchema),
});

export type CaseDetailRequest = z.infer<typeof caseDetailRequestSchema>;
export type CaseDetailCase = z.infer<typeof caseDetailCaseSchema>;
export type CaseDetailEntity = z.infer<typeof caseDetailEntitySchema>;
export type CaseDetailNote = z.infer<typeof caseDetailNoteSchema>;
export type CaseDetailActivity = z.infer<typeof caseDetailActivitySchema>;
export type CaseDetailMember = z.infer<typeof caseDetailMemberSchema>;
export type CaseDetailResponse = z.infer<typeof caseDetailResponseSchema>;
