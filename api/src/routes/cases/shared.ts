import { LOCKED_CASE_STATUSES, caseStatusSchema } from "../../../../shared/schemas/common.js";

// Both lists are derived from shared/schemas/common.ts rather than re-declared here. They used
// to be independent literals; the moment the web app needed to know which statuses lock a case
// (to disable the note/pin controls the API 409s on), keeping a second copy would have meant
// three places to update — exactly the drift PRD v1.1 N5 exists to close.
export const STATUSES = caseStatusSchema.options;

// A closed case freezes an evidence_snapshot for reporting, but that alone doesn't stop the
// live case record itself from being edited afterward — notes, pins, and unpins had no status
// check at all. Left unguarded, an auditor reading the case detail view could see edits made
// after "closing" that the frozen report never reflects.
export const LOCKED_STATUSES = new Set<string>(LOCKED_CASE_STATUSES);
