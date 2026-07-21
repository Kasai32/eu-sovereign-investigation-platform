import { useState } from "react";

type PurposeGateOptions = {
  title: string;
  description?: string;
  placeholder: string;
  /** Preserves each call site's original wrapper class exactly (they differ slightly today —
   * see the call sites) rather than silently normalizing a visual difference under a refactor. */
  containerClassName?: string;
};

const DEFAULT_DESCRIPTION = "Required — recorded in the audit log against your account.";

/**
 * Every "meaningful access moment" screen (entity detail, case workspace, case report export)
 * needs the exact same shape: hold real content back until the analyst types a purpose-of-use,
 * mirroring the API's own 400-without-it requirement (see PHASE1_REVIEW.md for why that's
 * required on these specific endpoints but defaulted elsewhere). This used to be three
 * near-identical ~25-line copies of the same state + form JSX; now it's one hook.
 *
 * Usage: `const { submittedPurpose, gate } = usePurposeGate({...}); if (gate) return gate;`
 */
export function usePurposeGate(options: PurposeGateOptions): { submittedPurpose: string; gate: JSX.Element | null } {
  const [purpose, setPurpose] = useState("");
  const [submittedPurpose, setSubmittedPurpose] = useState("");

  if (submittedPurpose) return { submittedPurpose, gate: null };

  const gate = (
    <div className={options.containerClassName ?? "mx-auto max-w-md"}>
      <h1 className="mb-2 text-xl font-semibold text-slate-900">{options.title}</h1>
      <p className="mb-4 text-sm text-slate-500">{options.description ?? DEFAULT_DESCRIPTION}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (purpose.trim()) setSubmittedPurpose(purpose.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder={options.placeholder}
          className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
          autoFocus
        />
        <button type="submit" className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700">
          Continue
        </button>
      </form>
    </div>
  );

  return { submittedPurpose: "", gate };
}
