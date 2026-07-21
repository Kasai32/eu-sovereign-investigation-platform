import { z } from "zod";

// Single source of truth for GET /cases/:id's request and response shapes, imported by both
// api/src/routes/cases/workspace.ts (validates what it actually sends) and
// web/src/lib/api/cases.ts (validates what it actually received) — see shared/README.md for
// why this exists and how to add the next route's schema here.

// Postgres's own `uuid` column type accepts any 8-4-4-4-12 hex value; it does not require
// RFC4122 version/variant nibbles the way Zod's stricter `z.uuid()` does by default. This
// codebase's seed data uses deliberately simple, human-readable ids (e.g.
// `11111111-1111-1111-1111-111111111104` for app_users — db/seed/*.sql) that are valid
// Postgres uuids but fail `z.uuid()`'s stricter check. `z.guid()` matches the column type's
// actual constraint instead of over-specifying one Postgres itself doesn't enforce.
const uuidSchema = z.guid();

// `pg` returns `timestamp`/`timestamptz` columns as JS `Date` objects, not strings — Fastify's
// `reply.send()` only turns them into ISO strings via JSON.stringify on the way out, which is
// invisible if you validate the raw pre-serialization object (as every route here does, to
// catch a shape mismatch before anything is sent, not after). Accepting both and normalizing
// makes the transform explicit instead of an implicit side effect of JSON.stringify.
const isoTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

export const classificationSchema = z.enum(["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"]);
export const caseStatusSchema = z.enum(["open", "under_review", "closed", "archived"]);

export const caseDetailRequestSchema = z.object({
  id: uuidSchema,
  purpose: z.string().min(1, "purpose is required to open a case"),
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
