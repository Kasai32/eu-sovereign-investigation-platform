import { z } from "zod";
import { caseStatusSchema, isoTimestampSchema, purposeSchema, uuidSchema } from "./common.js";

// Single source of truth for PATCH /cases/:id/status, imported by both
// api/src/routes/cases/lifecycle.ts (validates what it actually sends) and
// web/src/lib/api/cases.ts (validates what it actually received) — see shared/README.md.
//
// This route existed and worked long before anything in the web app called it: the close-case
// control was the missing piece found during DECISIONS.md #50's deploy verification, where the
// full alert→case→document→close cycle had to be finished with curl. Migrating it to a shared
// schema at the same time as building that control means the contract is checked from the very
// first call site, rather than a hand-asserted `request<T>` added now and migrated later.

export const caseStatusRequestSchema = z.object({
  id: uuidSchema,
  status: caseStatusSchema,
  purpose: purposeSchema("purpose is required to change case status"),
});

// Matches the `RETURNING id, status, evidence_snapshot, closed_at` on the UPDATE exactly.
// `evidence_snapshot` stays `unknown`: it's a jsonb blob whose internal shape is the report
// renderer's business (cases/lifecycle.ts builds it, the report endpoint consumes it), and
// pinning that shape here would make this schema a second place to update every time the
// snapshot gains a field, for no caller that reads it.
export const caseStatusResponseSchema = z.object({
  id: uuidSchema,
  status: caseStatusSchema,
  evidence_snapshot: z.unknown().nullable(),
  closed_at: isoTimestampSchema.nullable(),
});

export type CaseStatusRequest = z.infer<typeof caseStatusRequestSchema>;
export type CaseStatusResponse = z.infer<typeof caseStatusResponseSchema>;
