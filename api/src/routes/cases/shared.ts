export const STATUSES = ["open", "under_review", "closed", "archived"] as const;

// A closed case freezes an evidence_snapshot for reporting, but that alone doesn't stop the
// live case record itself from being edited afterward — notes, pins, and unpins had no status
// check at all. Left unguarded, an auditor reading the case detail view could see edits made
// after "closing" that the frozen report never reflects.
export const LOCKED_STATUSES = new Set(["closed", "archived"]);
