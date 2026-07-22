import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "../lib/api";
import { ApiError } from "../lib/api/client";
import { caseStatusSchema, isCaseLocked, type CaseStatus } from "../../../shared/schemas/common";

const STATUS_LABELS: Record<CaseStatus, string> = {
  open: "Open",
  under_review: "Under review",
  closed: "Closed",
  archived: "Archived",
};

/**
 * The workspace's status-change control — the missing piece of the alert→case→document→close
 * cycle in the UI. `PATCH /cases/:id/status` (and the evidence-snapshot freeze it performs on
 * close, DECISIONS.md #18) has existed since Phase 1, but nothing in the web app ever called
 * it: #50's deployment verification had to finish the cycle with curl.
 *
 * Purpose-of-use is collected here rather than inherited from the workspace's own opening
 * purpose ("reviewing assigned structuring alert" explains why the case was *read*, not why it
 * was closed). The API requires it with a 400 either way; asking again is what makes the audit
 * entry for the close say something an auditor can actually use.
 */
export function CaseStatusControl({
  caseId,
  currentStatus,
  onChanged,
}: {
  caseId: string;
  currentStatus: CaseStatus;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CaseStatus>(currentStatus);
  const [purpose, setPurpose] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.setCaseStatus(caseId, status, purpose.trim()),
    onSuccess: () => {
      setOpen(false);
      setPurpose("");
      onChanged();
    },
  });

  const options = caseStatusSchema.options.filter((s) => s !== currentStatus);

  function startEditing() {
    // Default to the transition an analyst actually wants from here: the natural next step of
    // the cycle, not whatever happens to sort first.
    setStatus(currentStatus === "closed" ? "archived" : currentStatus === "open" ? "under_review" : "closed");
    setPurpose("");
    mutation.reset();
    setOpen(true);
  }

  if (!open) {
    return (
      <button
        onClick={startEditing}
        data-testid="change-status-button"
        className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        Change status
      </button>
    );
  }

  return (
    <form
      data-testid="change-status-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (purpose.trim()) mutation.mutate();
      }}
      className="flex flex-wrap items-center gap-2 rounded border border-slate-300 bg-slate-50 px-2 py-1.5"
    >
      <label className="text-xs text-slate-600" htmlFor="case-status-select">
        New status
      </label>
      <select
        id="case-status-select"
        value={status}
        onChange={(e) => setStatus(e.target.value as CaseStatus)}
        className="rounded border border-slate-300 px-1.5 py-1 text-xs"
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <input
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        placeholder="Reason for this change…"
        aria-label="Reason for this status change"
        className="w-64 rounded border border-slate-300 px-2 py-1 text-xs"
        autoFocus
      />
      <button
        type="submit"
        disabled={!purpose.trim() || mutation.isPending}
        className="rounded bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {mutation.isPending ? "Saving…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded px-2 py-1 text-xs text-slate-600 underline hover:text-slate-900"
      >
        Cancel
      </button>
      {isCaseLocked(status) && !mutation.isError && (
        <p className="w-full text-xs text-amber-700">
          {status === "closed"
            ? "Closing freezes an evidence snapshot for the report, and blocks further notes and entity changes."
            : "Archiving blocks further notes and entity changes."}
        </p>
      )}
      {mutation.isError && (
        <p className="w-full text-xs text-red-600" data-testid="change-status-error">
          {mutation.error instanceof ApiError || mutation.error instanceof Error
            ? mutation.error.message
            : "Status change failed."}
        </p>
      )}
    </form>
  );
}
