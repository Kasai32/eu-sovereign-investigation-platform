import { z } from "zod";

// Primitives shared by more than one route schema. These started life private to
// `caseDetail.ts` (the first migrated route, DECISIONS.md #49); they moved here the moment a
// second route needed the identical definitions, so the two can't drift into subtly different
// notions of "a uuid" or "a timestamp" the way the hand-written types this whole directory
// replaces did.

// Postgres's own `uuid` column type accepts any 8-4-4-4-12 hex value; it does not require
// RFC4122 version/variant nibbles the way Zod's stricter `z.uuid()` does by default. This
// codebase's seed data uses deliberately simple, human-readable ids (e.g.
// `11111111-1111-1111-1111-111111111104` for app_users — db/seed/*.sql) that are valid
// Postgres uuids but fail `z.uuid()`'s stricter check. `z.guid()` matches the column type's
// actual constraint instead of over-specifying one Postgres itself doesn't enforce.
export const uuidSchema = z.guid();

// `pg` returns `timestamp`/`timestamptz` columns as JS `Date` objects, not strings — Fastify's
// `reply.send()` only turns them into ISO strings via JSON.stringify on the way out, which is
// invisible if you validate the raw pre-serialization object (as every route here does, to
// catch a shape mismatch before anything is sent, not after). Accepting both and normalizing
// makes the transform explicit instead of an implicit side effect of JSON.stringify.
export const isoTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

export const classificationSchema = z.enum(["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"]);

// The source `api/src/routes/cases/shared.ts`'s `STATUSES` is now derived from, matching the
// `case_status` check constraint in db/migrations/003_cases.sql.
export const caseStatusSchema = z.enum(["open", "under_review", "closed", "archived"]);

// The statuses in which the API rejects notes/pins/unpins with a 409 (DECISIONS.md #34) —
// `LOCKED_STATUSES` in api/src/routes/cases/shared.ts is built from this. Exported so the web
// app disables those controls from the same list the server enforces with, rather than a
// second hand-kept copy that can silently disagree with it.
export const LOCKED_CASE_STATUSES: readonly z.infer<typeof caseStatusSchema>[] = ["closed", "archived"];

export function isCaseLocked(status: z.infer<typeof caseStatusSchema>): boolean {
  return LOCKED_CASE_STATUSES.includes(status);
}

/**
 * Purpose-of-use, with one route-specific message used for BOTH the missing and the empty case.
 *
 * Zod's default `invalid_type` message ("Invalid input: expected string, received undefined")
 * is what a caller omitting `purpose` entirely got once these routes moved behind schemas —
 * strictly worse than the hand-written `"purpose is required to ..."` the routes replied with
 * before, and the omitted case is by far the more common one. Setting `error` covers it; the
 * `.min(1)` message covers `purpose: ""`.
 */
export function purposeSchema(message: string) {
  return z.string({ error: message }).min(1, message);
}

export type Classification = z.infer<typeof classificationSchema>;
export type CaseStatus = z.infer<typeof caseStatusSchema>;
