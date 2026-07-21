const COLORS: Record<string, string> = {
  PUBLIC: "bg-slate-100 text-slate-700 border-slate-300",
  INTERNAL: "bg-blue-50 text-blue-700 border-blue-300",
  SENSITIVE: "bg-amber-50 text-amber-800 border-amber-300",
  RESTRICTED: "bg-red-50 text-red-800 border-red-300",
};

export function ClassificationBadge({ classification }: { classification: string }) {
  const cls = COLORS[classification] ?? COLORS.INTERNAL;
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {classification}
    </span>
  );
}
